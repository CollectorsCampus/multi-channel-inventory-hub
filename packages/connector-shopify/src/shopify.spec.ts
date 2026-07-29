import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runConnectorContractTests } from '@hub/connector-sdk/testing';
import type { Ctx } from '@hub/connector-sdk';
import { centsToPrice, createShopifyConnector, priceToCents } from './shopify';
import type { ShopifyClient } from './client';

/**
 * Everything runs against a mock Admin API, never a live store (§10).
 *
 * That is not only politeness: a connector test that mutates a real shop would
 * change a seller's listings, and the contract suite is meant to be safe to run
 * on every commit.
 */

const WEBHOOK_SECRET = 'shpss_test_secret';
const LOCATION = 'gid://shopify/Location/1';
const VARIANT = 'gid://shopify/ProductVariant/111';
const INVENTORY_ITEM = 'gid://shopify/InventoryItem/222';
const PRODUCT = 'gid://shopify/Product/333';

const ctx = (overrides: Partial<Ctx> = {}): Ctx => ({
  channelInstanceId: 'chan-1',
  config: { shopDomain: 'test-store.myshopify.com', clientId: 'client-id', locationId: LOCATION },
  secrets: { clientSecret: 'client-secret', webhookSecret: WEBHOOK_SECRET },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ...overrides,
});

/** A mock Admin API that records what it was asked to do. */
function mockClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];

  const client: ShopifyClient = {
    async request<T>(_c: Ctx, query: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query, variables });

      if (query.includes('VariantForSync')) {
        return {
          node: {
            id: VARIANT,
            price: '12.50',
            product: { id: PRODUCT },
            inventoryItem: { id: INVENTORY_ITEM, tracked: true },
          },
        } as T;
      }

      if (query.includes('LiveListingState')) {
        return (overrides.liveState ?? {
          nodes: [
            {
              id: VARIANT,
              price: '12.50',
              inventoryItem: {
                id: INVENTORY_ITEM,
                tracked: true,
                inventoryLevels: {
                  nodes: [
                    {
                      location: { id: LOCATION },
                      quantities: [{ name: 'available', quantity: 7 }],
                    },
                    // A second location the hub does not manage.
                    {
                      location: { id: 'gid://shopify/Location/999' },
                      quantities: [{ name: 'available', quantity: 99 }],
                    },
                  ],
                },
              },
            },
          ],
        }) as T;
      }

      if (query.includes('SetInventoryQuantity')) {
        return { inventorySetQuantities: { userErrors: overrides.quantityErrors ?? [] } } as T;
      }

      if (query.includes('SetVariantPrice')) {
        return { productVariantsBulkUpdate: { userErrors: overrides.priceErrors ?? [] } } as T;
      }

      throw new Error(`Unexpected query: ${query.slice(0, 40)}`);
    },
  };

  return { client, calls };
}

function signedOrder(body: unknown, secret: string = WEBHOOK_SECRET) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(rawBody).digest('base64'),
    },
  };
}

const ORDER = {
  id: 5001,
  name: '#1001',
  admin_graphql_api_id: 'gid://shopify/Order/5001',
  created_at: '2026-07-28T10:00:00Z',
  line_items: [
    { id: 900, admin_graphql_api_variant_id: VARIANT, quantity: 2 },
    { id: 901, variant_id: 112, quantity: 1 },
  ],
};

describe('money conversion', () => {
  it('parses Shopify decimal strings without floating point', () => {
    expect(priceToCents('12.50')).toBe(1250);
    expect(priceToCents('0.99')).toBe(99);
    expect(priceToCents('1250')).toBe(125000);
    expect(priceToCents('2.49')).toBe(249);
  });

  it('formats cents back for Shopify', () => {
    expect(centsToPrice(1250)).toBe('12.50');
    expect(centsToPrice(99)).toBe('0.99');
    expect(centsToPrice(0)).toBe('0.00');
    expect(centsToPrice(100000)).toBe('1000.00');
  });

  it('round-trips', () => {
    for (const cents of [0, 1, 99, 100, 1250, 999999]) {
      expect(priceToCents(centsToPrice(cents))).toBe(cents);
    }
  });
});

describe('outbound', () => {
  it('sets an absolute quantity at the configured location', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.updateQuantity!(ctx(), {
      allocationId: 'a',
      externalListingId: VARIANT,
      quantity: 6,
    });

    const set = calls.find((c) => c.query.includes('SetInventoryQuantity'));
    expect(set?.variables?.input).toMatchObject({
      name: 'available',
      quantities: [{ inventoryItemId: INVENTORY_ITEM, locationId: LOCATION, quantity: 6 }],
    });
  });

  /**
   * The hub is the source of truth, so it states the quantity rather than
   * adjusting by a delta. A missed webhook then self-corrects on the next push
   * instead of compounding forever.
   */
  it('sets rather than adjusts, ignoring Shopify current value', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.updateQuantity!(ctx(), {
      allocationId: 'a',
      externalListingId: VARIANT,
      quantity: 6,
    });

    const input = calls.find((c) => c.query.includes('SetInventoryQuantity'))?.variables
      ?.input as Record<string, unknown>;
    expect(input.ignoreCompareQuantity).toBe(true);
  });

  it('surfaces a userErrors failure instead of reporting success', async () => {
    // Shopify answers 200 with userErrors; treating that as success would
    // record a listing that does not exist.
    const { client } = mockClient({
      quantityErrors: [{ field: ['quantities'], message: 'Item not stocked at location' }],
    });
    const connector = createShopifyConnector({ client });

    await expect(
      connector.updateQuantity!(ctx(), {
        allocationId: 'a',
        externalListingId: VARIANT,
        quantity: 1,
      }),
    ).rejects.toThrow(/not stocked at location/);
  });

  it('sets price as a decimal string', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.updatePrice!(ctx(), {
      allocationId: 'a',
      externalListingId: VARIANT,
      price: 2599,
      currency: 'USD',
    });

    const call = calls.find((c) => c.query.includes('SetVariantPrice'));
    expect(call?.variables).toMatchObject({
      productId: PRODUCT,
      variants: [{ id: VARIANT, price: '25.99' }],
    });
  });

  /** §6: we never destroy channel-side state. The seller's product is theirs. */
  it('delists by zeroing quantity, not by deleting anything', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.delist!(ctx(), { allocationId: 'a', externalListingId: VARIANT });

    const input = calls.find((c) => c.query.includes('SetInventoryQuantity'))?.variables?.input as {
      quantities: Array<{ quantity: number }>;
    };
    expect(input.quantities[0]!.quantity).toBe(0);
    expect(calls.some((c) => /delete/i.test(c.query))).toBe(false);
  });

  it('refuses to invent a Shopify product', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    await expect(
      connector.pushListing!(ctx(), {
        allocationId: 'a',
        externalListingId: null,
        sku: { skuId: 's', name: 'Card', condition: 'NM', printing: 'NORMAL', language: 'EN' },
        quantity: 1,
        price: 100,
        currency: 'USD',
      }),
    ).rejects.toThrow(/Create the product in Shopify/);
  });

  it('reports a missing locationId as configuration, not a crash', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    await expect(
      connector.updateQuantity!(ctx({ config: { shopDomain: 'x.myshopify.com' } }), {
        allocationId: 'a',
        externalListingId: VARIANT,
        quantity: 1,
      }),
    ).rejects.toThrow(/locationId is required/);
  });
});

describe('webhook verification', () => {
  const connector = createShopifyConnector({ client: mockClient().client });

  it('accepts a correctly signed body', () => {
    const { headers, rawBody } = signedOrder(ORDER);
    expect(connector.verifyWebhook!(ctx(), headers, rawBody)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { headers } = signedOrder(ORDER);
    expect(connector.verifyWebhook!(ctx(), headers, Buffer.from('{"forged":true}'))).toBe(false);
  });

  it('rejects a missing signature', () => {
    const { rawBody } = signedOrder(ORDER);
    expect(connector.verifyWebhook!(ctx(), {}, rawBody)).toBe(false);
  });

  it('rejects when no signing secret is configured at all', () => {
    const { headers, rawBody } = signedOrder(ORDER);
    expect(connector.verifyWebhook!(ctx({ secrets: {} }), headers, rawBody)).toBe(false);
  });

  /**
   * Shopify signs an app's webhooks with that app's client secret, so a
   * deployment that registered them through the app has nothing else to enter.
   * Falling back to it is what makes `webhookSecret` optional.
   */
  it('falls back to the client secret when no webhook secret is set', () => {
    const { headers, rawBody } = signedOrder(ORDER, WEBHOOK_SECRET);
    const clientSecretOnly = ctx({ secrets: { clientSecret: WEBHOOK_SECRET } });

    expect(connector.verifyWebhook!(clientSecretOnly, headers, rawBody)).toBe(true);
  });

  it('prefers an explicit webhook secret over the client secret', () => {
    // A subscription created by hand can carry a secret of its own.
    const { headers, rawBody } = signedOrder(ORDER, WEBHOOK_SECRET);
    const both = ctx({
      secrets: { clientSecret: 'a-different-secret', webhookSecret: WEBHOOK_SECRET },
    });

    expect(connector.verifyWebhook!(both, headers, rawBody)).toBe(true);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the guard must come first.
    const { rawBody } = signedOrder(ORDER);
    expect(connector.verifyWebhook!(ctx(), { 'x-shopify-hmac-sha256': 'AAAA' }, rawBody)).toBe(
      false,
    );
  });

  /**
   * The digest is over raw bytes. Re-serializing the JSON changes whitespace
   * and key order, and the signature then never matches — a failure mode that
   * looks like a credential problem and is painful to diagnose.
   */
  it('fails if the body was re-serialized before verifying', () => {
    const { headers, rawBody } = signedOrder(ORDER);
    const reSerialized = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()), null, 2));
    expect(connector.verifyWebhook!(ctx(), headers, reSerialized)).toBe(false);
  });
});

describe('webhook parsing', () => {
  const connector = createShopifyConnector({ client: mockClient().client });

  it('produces one sale per line item', () => {
    const { rawBody } = signedOrder(ORDER);
    const events = connector.parseWebhook!(ctx(), rawBody);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'sale',
      externalListingId: VARIANT,
      quantity: 2,
      orderReference: '#1001',
    });
    // A numeric variant_id is normalised to the same GID form the hub stores.
    expect(events[1]).toMatchObject({
      externalListingId: 'gid://shopify/ProductVariant/112',
      quantity: 1,
    });
  });

  it('gives redeliveries identical keys', () => {
    const { rawBody } = signedOrder(ORDER);
    const first = connector.parseWebhook!(ctx(), rawBody);
    const second = connector.parseWebhook!(ctx(), rawBody);
    expect(second.map((e) => e.externalEventId)).toEqual(first.map((e) => e.externalEventId));
  });

  it('gives distinct keys to different lines of one order', () => {
    const { rawBody } = signedOrder(ORDER);
    const [a, b] = connector.parseWebhook!(ctx(), rawBody);
    expect(a!.externalEventId).not.toBe(b!.externalEventId);
  });

  /**
   * Custom or deleted line items have no variant. They cannot map to an
   * allocation, and inventing a listing id would decrement the wrong SKU.
   */
  it('skips line items with no variant', () => {
    const { rawBody } = signedOrder({
      ...ORDER,
      line_items: [
        { id: 1, quantity: 1 },
        { id: 2, variant_id: 112, quantity: 3 },
      ],
    });
    const events = connector.parseWebhook!(ctx(), rawBody);
    expect(events).toHaveLength(1);
    expect(events[0]!.quantity).toBe(3);
  });

  it('skips non-positive quantities', () => {
    const { rawBody } = signedOrder({
      ...ORDER,
      line_items: [{ id: 1, variant_id: 111, quantity: 0 }],
    });
    expect(connector.parseWebhook!(ctx(), rawBody)).toEqual([]);
  });

  it('returns nothing for an order with no lines', () => {
    const { rawBody } = signedOrder({ id: 1, line_items: [] });
    expect(connector.parseWebhook!(ctx(), rawBody)).toEqual([]);
  });
});

describe('reconciliation', () => {
  it('reports the quantity at the managed location only', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const [state] = await connector.fetchLiveState!(ctx(), [VARIANT]);

    // The other location holds 99; the hub does not manage it (ADR 0001 §5).
    expect(state).toMatchObject({ externalListingId: VARIANT, quantity: 7, price: 1250 });
  });

  it('omits a variant not stocked at the managed location', async () => {
    const { client } = mockClient({
      liveState: {
        nodes: [
          {
            id: VARIANT,
            price: '1.00',
            inventoryItem: {
              inventoryLevels: {
                nodes: [
                  {
                    location: { id: 'gid://shopify/Location/999' },
                    quantities: [{ name: 'available', quantity: 5 }],
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const connector = createShopifyConnector({ client });

    // Reporting zero here would read as drift and raise a spurious alert.
    await expect(connector.fetchLiveState!(ctx(), [VARIANT])).resolves.toEqual([]);
  });

  it('omits variants Shopify did not return at all', async () => {
    const { client } = mockClient({ liveState: { nodes: [null] } });
    const connector = createShopifyConnector({ client });
    await expect(
      connector.fetchLiveState!(ctx(), ['gid://shopify/ProductVariant/gone']),
    ).resolves.toEqual([]);
  });

  it('does not call Shopify when asked about nothing', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await expect(connector.fetchLiveState!(ctx(), [])).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// The shared contract suite every connector must pass (§10).
runConnectorContractTests({
  connector: createShopifyConnector({ client: mockClient().client }),
  makeCtx: () => ctx(),
  validWebhook: signedOrder(ORDER),
});
