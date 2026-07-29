import { describe, expect, it } from 'vitest';
import type { Ctx } from '@hub/connector-sdk';
import { createShopifyClient, SHOPIFY_API_VERSION } from './client';
import { createTokenSource } from './tokens';
import { ShopifyError, ShopifyTransientError } from './errors';

/**
 * The GraphQL client, and specifically the seam where authentication meets it.
 *
 * Tokens now expire, so the interesting failure is one that cannot happen with
 * a permanent credential: a cached token that is still inside its lifetime and
 * has nonetheless been revoked — the app reinstalled, its scopes changed, the
 * secret rotated. Without a retry that channel stays broken until the cache
 * happens to lapse, which could be most of a day.
 */

const SHOP = 'test-store.myshopify.com';

const ctx = (): Ctx => ({
  channelInstanceId: 'chan-1',
  config: { shopDomain: SHOP, clientId: 'client-id' },
  secrets: { clientSecret: 'client-secret' },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

/** A fake Shopify answering both the token endpoint and GraphQL. */
function fakeShopify(graphql: Array<{ status?: number; body?: unknown }>) {
  const calls: string[] = [];
  let tokenSerial = 0;
  let index = 0;

  const doFetch = async (url: string): Promise<Response> => {
    calls.push(url);

    if (url.endsWith('/admin/oauth/access_token')) {
      tokenSerial++;
      return new Response(
        JSON.stringify({ access_token: `token-${tokenSerial}`, expires_in: 86399 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const next = graphql[Math.min(index, graphql.length - 1)]!;
    index++;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    doFetch,
    calls,
    tokenCalls: () => calls.filter((u) => u.endsWith('/admin/oauth/access_token')).length,
    graphqlCalls: () => calls.filter((u) => u.includes('/graphql.json')).length,
  };
}

const ok = { body: { data: { shop: { name: 'Test' } } } };

describe('createShopifyClient', () => {
  it('calls the pinned API version with the minted token', async () => {
    const shopify = fakeShopify([ok]);
    const client = createShopifyClient(shopify.doFetch);

    await client.request(ctx(), '{ shop { name } }');

    expect(shopify.calls.at(-1)).toBe(
      `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    );
    expect(shopify.tokenCalls()).toBe(1);
  });

  it('authenticates once and reuses the token across requests', async () => {
    const shopify = fakeShopify([ok]);
    const client = createShopifyClient(shopify.doFetch);

    await client.request(ctx(), '{ a }');
    await client.request(ctx(), '{ b }');
    await client.request(ctx(), '{ c }');

    expect(shopify.graphqlCalls()).toBe(3);
    expect(shopify.tokenCalls()).toBe(1);
  });

  /**
   * The behaviour that only matters because tokens expire. A revoked-but-unexpired
   * token looks valid to us and is not.
   */
  it('mints a new token and retries once on 401', async () => {
    const shopify = fakeShopify([{ status: 401 }, ok]);
    const client = createShopifyClient(shopify.doFetch);

    await expect(client.request(ctx(), '{ shop { name } }')).resolves.toEqual({
      shop: { name: 'Test' },
    });

    expect(shopify.tokenCalls()).toBe(2);
    expect(shopify.graphqlCalls()).toBe(2);
  });

  it('gives up after one retry rather than looping on bad credentials', async () => {
    // If the freshly minted token is also refused, the credentials are wrong
    // and repeating cannot help.
    const shopify = fakeShopify([{ status: 401 }, { status: 401 }, ok]);
    const client = createShopifyClient(shopify.doFetch);

    await expect(client.request(ctx(), '{ shop { name } }')).rejects.toBeInstanceOf(ShopifyError);
    expect(shopify.graphqlCalls()).toBe(2);
  });

  it('still treats throttling and outages as retryable', async () => {
    for (const status of [429, 502]) {
      const shopify = fakeShopify([{ status }]);
      const client = createShopifyClient(shopify.doFetch);
      await expect(client.request(ctx(), '{ a }')).rejects.toBeInstanceOf(ShopifyTransientError);
    }
  });

  it('reports a GraphQL error rather than returning empty data', async () => {
    const shopify = fakeShopify([{ body: { errors: [{ message: 'Field does not exist' }] } }]);
    const client = createShopifyClient(shopify.doFetch);

    await expect(client.request(ctx(), '{ nope }')).rejects.toThrow(/Field does not exist/);
  });

  it('treats Shopify’s 200-with-throttled as retryable', async () => {
    const shopify = fakeShopify([{ body: { errors: [{ message: 'Throttled' }] } }]);
    const client = createShopifyClient(shopify.doFetch);

    await expect(client.request(ctx(), '{ a }')).rejects.toBeInstanceOf(ShopifyTransientError);
  });

  it('refuses to call anything without a shop domain', async () => {
    const shopify = fakeShopify([ok]);
    const client = createShopifyClient(shopify.doFetch);
    const noShop: Ctx = { ...ctx(), config: {} };

    await expect(client.request(noShop, '{ a }')).rejects.toThrow(/shopDomain is missing/);
    expect(shopify.calls).toHaveLength(0);
  });

  it('accepts an injected token source, so the two are separable', async () => {
    const shopify = fakeShopify([ok]);
    const source = createTokenSource(shopify.doFetch);
    const client = createShopifyClient(shopify.doFetch, source);

    await client.request(ctx(), '{ a }');
    expect(shopify.tokenCalls()).toBe(1);
  });
});
