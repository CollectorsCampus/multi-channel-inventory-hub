import { describe, expect, it } from 'vitest';
import type { Ctx } from '@hub/connector-sdk';
import { createTokenSource } from './tokens';
import { ShopifyError, ShopifyTransientError } from './errors';

/**
 * The client-credentials token source.
 *
 * Shopify retired permanent Admin API tokens on 1 January 2026, so this is now
 * the thing standing between a queued push and the Shopify API. The behaviours
 * worth pinning are the ones that only misbehave under load or over time —
 * caching, collapsing a burst, refreshing before expiry, and not confusing two
 * stores' tokens — none of which a single happy-path call would reveal.
 */

const SHOP = 'my-store.myshopify.com';

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    channelInstanceId: 'channel-1',
    config: { shopDomain: SHOP, clientId: 'client-id' },
    secrets: { clientSecret: 'client-secret' },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

/** A fake token endpoint that records what it was asked. */
function fakeShopify(
  responses: Array<{ status?: number; body?: unknown }> = [{ body: token('a') }],
) {
  const calls: Array<{ url: string; body: string }> = [];
  let index = 0;

  const doFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: String(init?.body ?? '') });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { doFetch, calls };
}

const token = (value: string, expiresIn = 86399) => ({
  access_token: value,
  scope: 'read_products,write_products',
  expires_in: expiresIn,
});

describe('createTokenSource', () => {
  it('exchanges the client credentials exactly as Shopify documents', async () => {
    const shopify = fakeShopify();
    const source = createTokenSource(shopify.doFetch);

    await expect(source.get(ctx(), SHOP)).resolves.toBe('a');

    expect(shopify.calls[0]!.url).toBe(`https://${SHOP}/admin/oauth/access_token`);

    // Form-encoded, not JSON — their token endpoint documents
    // application/x-www-form-urlencoded.
    const body = new URLSearchParams(shopify.calls[0]!.body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
  });

  it('reuses a cached token rather than minting one per request', async () => {
    const shopify = fakeShopify();
    const source = createTokenSource(shopify.doFetch);

    await source.get(ctx(), SHOP);
    await source.get(ctx(), SHOP);
    await source.get(ctx(), SHOP);

    expect(shopify.calls).toHaveLength(1);
  });

  /**
   * A burst of queued pushes on a cold cache would otherwise each mint their
   * own token, and Shopify rate-limits this endpoint like any other.
   */
  it('collapses a concurrent burst onto one request', async () => {
    const shopify = fakeShopify();
    const source = createTokenSource(shopify.doFetch);

    const results = await Promise.all([
      source.get(ctx(), SHOP),
      source.get(ctx(), SHOP),
      source.get(ctx(), SHOP),
      source.get(ctx(), SHOP),
    ]);

    expect(shopify.calls).toHaveLength(1);
    expect(results).toEqual(['a', 'a', 'a', 'a']);
  });

  /**
   * Refreshing exactly at expiry means a token that lapses in flight fails a
   * push that had nothing wrong with it.
   */
  it('refreshes early, before Shopify would expire the token', async () => {
    const shopify = fakeShopify([{ body: token('first') }, { body: token('second') }]);
    let clock = 1_000_000;
    const source = createTokenSource(shopify.doFetch, () => clock);

    expect(await source.get(ctx(), SHOP)).toBe('first');

    // 23h55m: inside the 24h life, but past the safety margin.
    clock += (86399 - 5 * 60) * 1000 + 1;
    expect(await source.get(ctx(), SHOP)).toBe('second');
    expect(shopify.calls).toHaveLength(2);
  });

  it('keeps using a token that is still comfortably valid', async () => {
    const shopify = fakeShopify([{ body: token('first') }, { body: token('second') }]);
    let clock = 1_000_000;
    const source = createTokenSource(shopify.doFetch, () => clock);

    await source.get(ctx(), SHOP);
    clock += 12 * 60 * 60 * 1000;

    expect(await source.get(ctx(), SHOP)).toBe('first');
    expect(shopify.calls).toHaveLength(1);
  });

  /**
   * Two Shopify stores are two installations with two client secrets. A shared
   * cache would send one store's token to the other, which would fail — or,
   * worse, succeed against the wrong shop.
   */
  it('keeps each channel’s token to itself', async () => {
    const shopify = fakeShopify([{ body: token('store-a') }, { body: token('store-b') }]);
    const source = createTokenSource(shopify.doFetch);

    const a = await source.get(ctx({ channelInstanceId: 'channel-a' }), SHOP);
    const b = await source.get(ctx({ channelInstanceId: 'channel-b' }), 'other.myshopify.com');

    expect(a).toBe('store-a');
    expect(b).toBe('store-b');
    expect(shopify.calls).toHaveLength(2);
  });

  it('mints a fresh token after being invalidated', async () => {
    const shopify = fakeShopify([{ body: token('stale') }, { body: token('fresh') }]);
    const source = createTokenSource(shopify.doFetch);

    expect(await source.get(ctx(), SHOP)).toBe('stale');
    source.invalidate('channel-1');
    expect(await source.get(ctx(), SHOP)).toBe('fresh');
  });

  it('reads the stated lifetime rather than assuming a day', async () => {
    // Documented as always 86399, but a hard-coded day would outlive the token
    // the moment that changes.
    const shopify = fakeShopify([{ body: token('short', 600) }, { body: token('next', 600) }]);
    let clock = 1_000_000;
    const source = createTokenSource(shopify.doFetch, () => clock);

    await source.get(ctx(), SHOP);
    clock += 5 * 60 * 1000 + 1; // past 600s minus the 5-minute margin

    expect(await source.get(ctx(), SHOP)).toBe('next');
  });

  describe('failures', () => {
    it('refuses to retry bad credentials', async () => {
      // Wrong secret, uninstalled app and a shop that is not ours all fail
      // identically forever; burning the queue's retry budget delays everything
      // behind them.
      const shopify = fakeShopify([
        { status: 401, body: { error: 'invalid_client', error_description: 'bad secret' } },
      ]);
      const source = createTokenSource(shopify.doFetch);

      const failing = source.get(ctx(), SHOP);
      await expect(failing).rejects.toBeInstanceOf(ShopifyError);
      await expect(failing).rejects.not.toBeInstanceOf(ShopifyTransientError);
      await expect(failing).rejects.toThrow(/bad secret/);
    });

    it('treats throttling and outages as retryable', async () => {
      for (const status of [429, 500, 503]) {
        const shopify = fakeShopify([{ status, body: {} }]);
        const source = createTokenSource(shopify.doFetch);
        await expect(source.get(ctx(), SHOP)).rejects.toBeInstanceOf(ShopifyTransientError);
      }
    });

    it('treats an unreachable Shopify as retryable', async () => {
      const source = createTokenSource(async () => {
        throw new Error('ECONNREFUSED');
      });
      await expect(source.get(ctx(), SHOP)).rejects.toBeInstanceOf(ShopifyTransientError);
    });

    it('says what is missing when the channel is half-configured', async () => {
      const shopify = fakeShopify();
      const source = createTokenSource(shopify.doFetch);

      await expect(source.get(ctx({ config: { shopDomain: SHOP } }), SHOP)).rejects.toThrow(
        /clientId is missing/,
      );

      await expect(source.get(ctx({ secrets: {} }), SHOP)).rejects.toThrow(/client secret/i);
      expect(shopify.calls).toHaveLength(0);
    });

    it('explains that legacy tokens are gone, since that is the likely confusion', async () => {
      const source = createTokenSource(fakeShopify().doFetch);
      await expect(source.get(ctx({ secrets: {} }), SHOP)).rejects.toThrow(/1 January 2026/);
    });

    it('does not cache a failure', async () => {
      const shopify = fakeShopify([{ status: 500, body: {} }, { body: token('recovered') }]);
      const source = createTokenSource(shopify.doFetch);

      await expect(source.get(ctx(), SHOP)).rejects.toBeInstanceOf(ShopifyTransientError);
      expect(await source.get(ctx(), SHOP)).toBe('recovered');
    });
  });
});
