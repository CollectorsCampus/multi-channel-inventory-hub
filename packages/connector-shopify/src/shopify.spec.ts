import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runConnectorContractTests } from '@hub/connector-sdk/testing';
import type { CreateListingRequest, Ctx } from '@hub/connector-sdk';
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
const NEW_PRODUCT = 'gid://shopify/Product/444';
const NEW_VARIANT = 'gid://shopify/ProductVariant/555';
const CODE = 'tcgcsv:662182:NM:NORMAL:EN';

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
  let tagPage = 0;

  const client: ShopifyClient = {
    async request<T>(_c: Ctx, query: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query, variables });

      if (query.includes('VariantForSync')) {
        return (overrides.variant ?? {
          node: {
            id: VARIANT,
            price: '12.50',
            product: { id: PRODUCT },
            inventoryItem: {
              id: INVENTORY_ITEM,
              tracked: true,
              // Carried on this query because the mandatory compare-and-swap
              // needs the current quantity in the same round trip as the id.
              inventoryLevels: {
                nodes: [
                  {
                    location: { id: LOCATION },
                    quantities: [{ name: 'available', quantity: 7 }],
                  },
                  {
                    location: { id: 'gid://shopify/Location/999' },
                    quantities: [{ name: 'available', quantity: 99 }],
                  },
                ],
              },
            },
          },
        }) as T;
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

      if (query.includes('EnumerateListings')) {
        return (overrides.enumerate ?? {
          productVariants: {
            pageInfo: { hasNextPage: false, endCursor: 'cursor-1' },
            nodes: [
              {
                id: VARIANT,
                title: 'Default Title',
                displayName: 'Surging Sparks Elite Trainer Box - Default Title',
                sku: 'PKM-SSP-ETB',
                barcode: '820650861234',
                price: '49.99',
                product: { title: 'Surging Sparks Elite Trainer Box', status: 'ACTIVE' },
              },
              {
                id: 'gid://shopify/ProductVariant/112',
                title: 'Near Mint',
                displayName: 'Pikachu ex - Near Mint',
                price: '3.50',
                product: { title: 'Pikachu ex', status: 'DRAFT' },
              },
            ],
          },
        }) as T;
      }

      if (query.includes('SetInventoryQuantity')) {
        return { inventorySetQuantities: { userErrors: overrides.quantityErrors ?? [] } } as T;
      }

      if (query.includes('SetVariantSku')) {
        return { productVariantsBulkUpdate: { userErrors: overrides.skuErrors ?? [] } } as T;
      }

      if (query.includes('SetVariantPrice')) {
        return { productVariantsBulkUpdate: { userErrors: overrides.priceErrors ?? [] } } as T;
      }

      if (query.includes('FindVariantBySku')) {
        return (overrides.findBySku ?? { productVariants: { nodes: [] } }) as T;
      }

      if (query.includes('CreateDraftProduct')) {
        return (overrides.createProduct ?? {
          productCreate: {
            product: { id: NEW_PRODUCT, variants: { nodes: [{ id: NEW_VARIANT }] } },
            userErrors: overrides.createProductErrors ?? [],
          },
        }) as T;
      }

      if (query.includes('CreateProductVariant')) {
        return (overrides.createVariant ?? {
          productVariantsBulkCreate: {
            productVariants: [{ id: NEW_VARIANT }],
            userErrors: overrides.createVariantErrors ?? [],
          },
        }) as T;
      }

      if (query.includes('HubProductTags')) {
        const pages = (overrides.tagPages ?? [
          {
            productTags: {
              pageInfo: { hasNextPage: false },
              edges: [{ node: 'Pokémon' }, { node: 'SV04 Paradox Rift' }],
            },
          },
        ]) as unknown[];

        // Served in order, so a test can prove pagination is followed rather
        // than the first page being taken for the whole vocabulary.
        return (pages[tagPage++] ?? pages[pages.length - 1]) as T;
      }

      if (query.includes('HubMetafieldDefinitions')) {
        const byOwner = (overrides.metafieldDefinitions ?? {
          PRODUCT: [
            {
              name: 'Game',
              namespace: 'custom',
              key: 'game',
              type: { name: 'metaobject_reference' },
            },
            {
              name: 'Rarity',
              namespace: 'shopify',
              key: 'rarity',
              type: { name: 'list.metaobject_reference' },
            },
            {
              name: 'Card number',
              namespace: 'custom',
              key: 'number',
              type: { name: 'single_line_text_field' },
            },
            {
              name: 'Never used',
              namespace: 'custom',
              key: 'unused',
              type: { name: 'metaobject_reference' },
            },
          ],
          PRODUCTVARIANT: [],
        }) as Record<string, unknown[]>;

        return {
          metafieldDefinitions: { nodes: byOwner[variables?.ownerType as string] ?? [] },
        } as T;
      }

      if (query.includes('HubMetafieldOwners')) {
        // One aliased `products(first: 1, query: "metafields.ns.key:*")` per
        // reference field. The mock answers by reading the filters back out of
        // the document, which is also how it proves each field was asked for by
        // name rather than sampled.
        const owners = (overrides.metafieldOwners ?? {
          'custom.game': { type: 'game', list: false },
          'shopify.rarity': { type: 'shopify--rarity', list: true },
        }) as Record<string, { type: string; list: boolean }>;

        const answer: Record<string, unknown> = {};
        for (const [, alias, wanted] of query.matchAll(
          /(f\d+): products\(first: 1, query: "metafields\.([^:]+):\*"\)/g,
        )) {
          const known = owners[wanted!];
          answer[alias!] = known
            ? {
                nodes: [
                  {
                    metafields: {
                      nodes: [
                        {
                          namespace: wanted!.split('.')[0],
                          key: wanted!.split('.').slice(1).join('.'),
                          reference: known.list ? null : { type: known.type },
                          references: known.list ? { nodes: [{ type: known.type }] } : null,
                        },
                      ],
                    },
                  },
                ],
              }
            : // No product carries it — the real answer for an unused field.
              { nodes: [] };
        }
        return answer as T;
      }

      if (query.includes('HubMetafieldSample')) {
        // The second pass. Empty by default so the targeted lookup above is
        // what the other tests exercise.
        return (overrides.metafieldSample ?? { products: { nodes: [] } }) as T;
      }

      if (query.includes('HubMetaobjectEntries')) {
        const byType = (overrides.metaobjects ?? {
          game: { nodes: [{ id: 'gid://shopify/Metaobject/1', displayName: 'Pokémon' }] },
          'shopify--rarity': {
            nodes: [{ id: 'gid://shopify/Metaobject/9', displayName: 'Rare' }],
          },
        }) as Record<string, unknown>;

        return { metaobjects: byType[variables?.type as string] ?? null } as T;
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
   *
   * `changeFromQuantity` is typed nullable but rejected at runtime when absent —
   * it replaced `ignoreCompareQuantity: true`, turning an opt-out into a
   * mandatory compare-and-swap. So the push sends an absolute target *and* the
   * value it read a moment earlier.
   */
  it('sends an absolute quantity with Shopify’s current value to compare against', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.updateQuantity!(ctx(), {
      allocationId: 'a',
      externalListingId: VARIANT,
      quantity: 6,
    });

    const input = calls.find((c) => c.query.includes('SetInventoryQuantity'))?.variables?.input as {
      quantities?: Array<Record<string, unknown>>;
    };

    // 6 is the target, not a delta; 7 is what the mock says Shopify holds.
    expect(input.quantities?.[0]).toMatchObject({
      quantity: 6,
      changeFromQuantity: 7,
      locationId: LOCATION,
      inventoryItemId: INVENTORY_ITEM,
    });
  });

  it('does not write at all when Shopify already shows the right number', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    // The mock reports 7 available.
    await connector.updateQuantity!(ctx(), {
      allocationId: 'a',
      externalListingId: VARIANT,
      quantity: 7,
    });

    expect(calls.some((c) => c.query.includes('SetInventoryQuantity'))).toBe(false);
  });

  /**
   * The race the compare exists to catch: a customer buys between our read and
   * our write. Re-reading is exactly what fixes it, so one retry turns a lost
   * push into a correct one.
   */
  it('re-reads and retries once when the compare value went stale', async () => {
    let attempts = 0;
    const { client, calls } = mockClient({
      get quantityErrors() {
        attempts++;
        return attempts === 1
          ? [{ message: 'changeFromQuantity does not match current quantity' }]
          : [];
      },
    });

    const connector = createShopifyConnector({ client });

    await expect(
      connector.updateQuantity!(ctx(), {
        allocationId: 'a',
        externalListingId: VARIANT,
        quantity: 6,
      }),
    ).resolves.toBeUndefined();

    expect(calls.filter((c) => c.query.includes('SetInventoryQuantity'))).toHaveLength(2);
    // The retry re-read rather than reusing the stale value.
    expect(calls.filter((c) => c.query.includes('VariantForSync'))).toHaveLength(2);
  });

  it('gives up after one retry rather than looping on contention', async () => {
    const { client, calls } = mockClient({
      quantityErrors: [{ message: 'changeFromQuantity does not match current quantity' }],
    });
    const connector = createShopifyConnector({ client });

    await expect(
      connector.updateQuantity!(ctx(), {
        allocationId: 'a',
        externalListingId: VARIANT,
        quantity: 6,
      }),
    ).rejects.toThrow(/Setting quantity failed/);

    expect(calls.filter((c) => c.query.includes('SetInventoryQuantity'))).toHaveLength(2);
  });

  it('says which location is wrong when the variant is not stocked there', async () => {
    const { client } = mockClient({
      variant: {
        node: {
          id: VARIANT,
          price: '12.50',
          product: { id: PRODUCT },
          inventoryItem: { id: INVENTORY_ITEM, tracked: true, inventoryLevels: { nodes: [] } },
        },
      },
    });
    const connector = createShopifyConnector({ client });

    await expect(
      connector.updateQuantity!(ctx(), {
        allocationId: 'a',
        externalListingId: VARIANT,
        quantity: 6,
      }),
    ).rejects.toThrow(/not stocked at location/);
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

  /**
   * A push still refuses to create, and that is not an oversight now that
   * `listing.create` exists — it is the division of labour. A
   * `PushListingRequest` carries no title, image or vendor, so a connector
   * creating from one would be inventing them. Creation is a separate call
   * where the operator supplies the content.
   */
  it('refuses to invent a Shopify product', async () => {
    const { client, calls } = mockClient();
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
    ).rejects.toThrow(/Create the listing first/);

    // Refused before anything reached Shopify, not part-way through.
    expect(calls).toEqual([]);
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

describe('writing our id into the SKU field', () => {
  it('writes through inventoryItem, which is where Shopify keeps a variant SKU', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.updateListingSku!(ctx(), { externalListingId: VARIANT, sku: '704143' });

    const write = calls.find((c) => c.query.includes('SetVariantSku'));
    expect(write?.variables).toMatchObject({
      productId: PRODUCT,
      variants: [{ id: VARIANT, inventoryItem: { sku: '704143' } }],
    });
  });

  /**
   * The matcher's `certain` path is an equality test against this value. A
   * connector that prefixed or tidied it would quietly turn tomorrow's exact
   * match back into a name guess.
   */
  it('writes the id verbatim', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.updateListingSku!(ctx(), { externalListingId: VARIANT, sku: '00704143' });

    const write = calls.find((c) => c.query.includes('SetVariantSku'));
    const variants = write?.variables?.variants as Array<{ inventoryItem: { sku: string } }>;
    // Not trimmed to '704143', not prefixed, not coerced to a number.
    expect(variants[0]!.inventoryItem.sku).toBe('00704143');
  });

  it('refuses to blank a seller’s SKU', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    // Shopify would accept this and the seller's code would be gone.
    await expect(
      connector.updateListingSku!(ctx(), { externalListingId: VARIANT, sku: '   ' }),
    ).rejects.toThrow(/empty SKU/i);

    expect(calls.filter((c) => c.query.includes('SetVariantSku'))).toEqual([]);
  });

  it('surfaces a Shopify user error rather than reporting success', async () => {
    const { client } = mockClient({ skuErrors: [{ message: 'SKU already in use' }] });
    const connector = createShopifyConnector({ client });

    await expect(
      connector.updateListingSku!(ctx(), { externalListingId: VARIANT, sku: '704143' }),
    ).rejects.toThrow(/SKU already in use/);
  });
});

describe('creating a listing', () => {
  const req = (overrides: Partial<CreateListingRequest> = {}): CreateListingRequest => ({
    sku: CODE,
    title: 'Pikachu ex - 013/094',
    optionName: 'Condition',
    optionValue: 'Near Mint',
    ...overrides,
  });

  it('creates the product as a draft, never active', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    const result = await connector.createListing!(ctx(), req());

    const create = calls.find((c) => c.query.includes('CreateDraftProduct'));
    // Nothing should become buyable because a background job ran.
    expect((create?.variables?.product as { status: string }).status).toBe('DRAFT');
    expect(result).toEqual({
      externalListingId: NEW_VARIANT,
      createdProduct: true,
      alreadyExisted: false,
    });
  });

  it('declares the condition as a product option, so the card is one product', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), req());

    const create = calls.find((c) => c.query.includes('CreateDraftProduct'));
    expect((create?.variables?.product as { productOptions: unknown }).productOptions).toEqual([
      { name: 'Condition', values: [{ name: 'Near Mint' }] },
    ]);
  });

  it('marks the variant tracked, or every later quantity push is ignored', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), req({ price: 1299 }));

    const fill = calls.find((c) => c.query.includes('SetVariantSku'));
    const variants = fill?.variables?.variants as Array<Record<string, unknown>>;
    expect(variants[0]).toMatchObject({
      id: NEW_VARIANT,
      price: '12.99',
      inventoryItem: { sku: CODE, tracked: true },
    });
  });

  it('sets no quantity, leaving stock to the one code path that owns it', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), req());

    // Rule 5: quantities move through InventoryService and the push path only.
    expect(calls.some((c) => c.query.includes('SetInventoryQuantity'))).toBe(false);
    const create = calls.find((c) => c.query.includes('CreateDraftProduct'));
    expect(JSON.stringify(create?.variables)).not.toContain('inventoryQuantities');
  });

  /**
   * The failure that is visible to customers. Re-running a selection must not
   * put a second copy of a card on the storefront.
   */
  it('returns the existing variant instead of creating a duplicate', async () => {
    const { client, calls } = mockClient({
      findBySku: { productVariants: { nodes: [{ id: VARIANT, sku: CODE }] } },
    });
    const connector = createShopifyConnector({ client });

    const result = await connector.createListing!(ctx(), req());

    expect(result).toEqual({
      externalListingId: VARIANT,
      createdProduct: false,
      alreadyExisted: true,
    });
    expect(calls.some((c) => c.query.includes('CreateDraftProduct'))).toBe(false);
  });

  /**
   * Shopify's variant search is not an exact-match engine, and `sku:` is a
   * prefix-ish query. Trusting it would hand back somebody else's variant to be
   * linked, which points the ledger at the wrong listing.
   */
  it('ignores a near-match the search returned', async () => {
    const { client } = mockClient({
      findBySku: {
        productVariants: { nodes: [{ id: VARIANT, sku: 'tcgcsv:662182:LP:NORMAL:EN' }] },
      },
    });
    const connector = createShopifyConnector({ client });

    const result = await connector.createListing!(ctx(), req());

    expect(result.alreadyExisted).toBe(false);
    expect(result.externalListingId).toBe(NEW_VARIANT);
  });

  /**
   * Our codes contain colons, and Shopify's search syntax uses a colon as its
   * field separator. Unquoted, `sku:tcgcsv:662182:...` parses as a field named
   * `tcgcsv`, matches nothing, and reads as "not there" — which duplicates the
   * product.
   */
  it('quotes the SKU in the search, because a code contains colons', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), req());

    const find = calls.find((c) => c.query.includes('FindVariantBySku'));
    expect(find?.variables?.query).toBe(`sku:"${CODE}"`);
  });

  /**
   * Escaping quotes but not backslashes leaves the escape character itself
   * unescaped, so a value ending in `\` escapes the closing quote and the rest
   * of the query joins the string — the search then means something nobody
   * asked for. CodeQL caught this as `js/incomplete-sanitization` on the first
   * version of this connector method.
   */
  it('escapes backslashes as well as quotes in the search value', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), req({ sku: 'weird\\"sku\\' }));

    const find = calls.find((c) => c.query.includes('FindVariantBySku'));
    // The backslashes are doubled, so the trailing one cannot eat the closing
    // quote, and the embedded quote stays escaped.
    expect(find?.variables?.query).toBe('sku:"weird\\\\\\"sku\\\\"');
  });

  it('adds a variant to the sibling’s product rather than making a second one', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    const result = await connector.createListing!(
      ctx(),
      req({
        sku: 'tcgcsv:662182:LP:NORMAL:EN',
        optionValue: 'Lightly Played',
        siblingListingId: VARIANT,
      }),
    );

    expect(calls.some((c) => c.query.includes('CreateDraftProduct'))).toBe(false);
    const add = calls.find((c) => c.query.includes('CreateProductVariant'));
    // The product resolved from the sibling variant, not invented.
    expect(add?.variables?.productId).toBe(PRODUCT);
    expect((add?.variables?.variants as Array<Record<string, unknown>>)[0]).toMatchObject({
      optionValues: [{ optionName: 'Condition', name: 'Lightly Played' }],
      inventoryItem: { sku: 'tcgcsv:662182:LP:NORMAL:EN', tracked: true },
    });
    expect(result).toEqual({
      externalListingId: NEW_VARIANT,
      createdProduct: false,
      alreadyExisted: false,
    });
  });

  /**
   * Shopify has changed whether `productCreate` materialises a variant for a
   * declared option before, and this connector has already been caught by three
   * schema changes in one sitting. Both shapes must work.
   */
  it('creates the variant itself when productCreate returned none', async () => {
    const { client, calls } = mockClient({
      createProduct: {
        productCreate: { product: { id: NEW_PRODUCT, variants: { nodes: [] } }, userErrors: [] },
      },
    });
    const connector = createShopifyConnector({ client });

    const result = await connector.createListing!(ctx(), req());

    const add = calls.find((c) => c.query.includes('CreateProductVariant'));
    expect(add?.variables?.productId).toBe(NEW_PRODUCT);
    expect(result.externalListingId).toBe(NEW_VARIANT);
    expect(result.createdProduct).toBe(true);
  });

  it('applies tags verbatim and only when given', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), req({ tags: ['Pokémon', 'ME02 Phantasmal Flames'] }));
    const withTags = calls.find((c) => c.query.includes('CreateDraftProduct'));
    // Not normalised: the store's collections match an exact tag, accent and all.
    expect((withTags?.variables?.product as { tags: string[] }).tags).toEqual([
      'Pokémon',
      'ME02 Phantasmal Flames',
    ]);

    const second = mockClient();
    await createShopifyConnector({ client: second.client }).createListing!(ctx(), req());
    const noTags = second.calls.find((c) => c.query.includes('CreateDraftProduct'));
    expect((noTags?.variables?.product as Record<string, unknown>).tags).toBeUndefined();
  });

  it('refuses a request with no SKU, because that is the idempotency key', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await expect(connector.createListing!(ctx(), req({ sku: '  ' }))).rejects.toThrow(/no SKU/i);
    expect(calls).toEqual([]);
  });

  it('refuses a request with no title', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    await expect(connector.createListing!(ctx(), req({ title: ' ' }))).rejects.toThrow(/no title/i);
  });

  it('surfaces a Shopify user error rather than reporting success', async () => {
    const { client } = mockClient({
      createProduct: {
        productCreate: { product: null, userErrors: [{ message: 'Title cannot be blank' }] },
      },
    });
    const connector = createShopifyConnector({ client });

    await expect(connector.createListing!(ctx(), req())).rejects.toThrow(/Title cannot be blank/);
  });
});

describe('enumerating existing listings', () => {
  it('reports the variant GID that everything else keys on', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), {});

    // This id is written straight onto an allocation on confirmation, and every
    // later push reads it back. If it were a bare numeric id, or a Product
    // rather than ProductVariant GID, the link would resolve to nothing on the
    // first sale instead of failing where someone could see it.
    expect(page.listings[0]!.externalListingId).toBe(VARIANT);
    expect(page.listings[0]!.externalListingId).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
  });

  it('prefers displayName, which already reads as product plus variant', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), {});
    expect(page.listings[0]!.title).toBe('Surging Sparks Elite Trainer Box - Default Title');
  });

  it('carries sku and barcode when present and omits them when not', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), {});

    // The only two fields that can make a match certain rather than probable.
    expect(page.listings[0]!.sku).toBe('PKM-SSP-ETB');
    expect(page.listings[0]!.barcode).toBe('820650861234');

    // Most TCG variants have neither, and an empty string would look to a
    // matcher like a value that simply matches nothing.
    expect(page.listings[1]!.sku).toBeUndefined();
    expect(page.listings[1]!.barcode).toBeUndefined();
  });

  it('converts price to integer cents', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), {});

    // 49.99 * 100 is 4998.999999999999 in IEEE-754.
    expect(page.listings[0]!.price).toBe(4999);
    expect(page.listings[1]!.price).toBe(350);
  });

  it('marks a draft product inactive rather than proposing it as live', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), {});

    expect(page.listings[0]!.active).toBe(true);
    // Linking stock to something nobody can buy is worse than not offering it.
    expect(page.listings[1]!.active).toBe(false);
  });

  /**
   * Fetching inventory levels per variant would multiply the query cost by the
   * page size and hit Shopify's calculated-cost limit on any real catalogue.
   * Quantity for a known listing is `fetchLiveState`'s job.
   */
  it('does not ask for inventory levels', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.enumerateListings!(ctx(), {});

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).not.toContain('inventoryLevels');
    expect(page_quantity_absent(await connector.enumerateListings!(ctx(), {}))).toBe(true);
  });

  it('passes the cursor through and returns the next one only when there is a page', async () => {
    const { client, calls } = mockClient({
      enumerate: {
        productVariants: {
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          nodes: [{ id: VARIANT, displayName: 'A', product: { status: 'ACTIVE' } }],
        },
      },
    });
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), { cursor: 'cursor-1', limit: 50 });

    expect(calls[0]!.variables).toMatchObject({ after: 'cursor-1', first: 50 });
    expect(page.nextCursor).toBe('cursor-2');
  });

  it('omits the cursor on the last page even though Shopify still sends one', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    // The mock's pageInfo has hasNextPage false but a non-null endCursor, which
    // is exactly what Shopify returns. Trusting endCursor alone would loop.
    const page = await connector.enumerateListings!(ctx(), {});
    expect(page.nextCursor).toBeUndefined();
  });

  /**
   * Matching is scoped to one set while a page of a real storefront is not.
   * Measured on a live Pokémon shop: 100 variants against one set's candidates
   * gave 2 matches and 98 rows of noise, and the noise is what stops a review
   * screen being read.
   */
  it('passes the search term to Shopify so a page is not all noise', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.enumerateListings!(ctx(), { search: 'Surging Sparks' });

    expect(calls[0]!.query).toContain('query: $query');
    expect(calls[0]!.variables).toMatchObject({ query: 'Surging Sparks' });
  });

  it('sends null rather than an empty search, which Shopify treats as a filter', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.enumerateListings!(ctx(), { search: '   ' });
    expect(calls[0]!.variables).toMatchObject({ query: null });

    await connector.enumerateListings!(ctx(), {});
    expect(calls[1]!.variables).toMatchObject({ query: null });
  });

  it('clamps the page size to what Shopify will accept', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.enumerateListings!(ctx(), { limit: 5000 });
    // Over 250 is an error from Shopify, not a truncation.
    expect(calls[0]!.variables).toMatchObject({ first: 250 });

    await connector.enumerateListings!(ctx(), { limit: 0 });
    expect(calls[1]!.variables).toMatchObject({ first: 1 });
  });

  it('skips a variant with no id rather than inventing one', async () => {
    const { client } = mockClient({
      enumerate: {
        productVariants: {
          pageInfo: { hasNextPage: false },
          nodes: [null, { displayName: 'No id here' }, { id: VARIANT, displayName: 'Real' }],
        },
      },
    });
    const connector = createShopifyConnector({ client });

    const page = await connector.enumerateListings!(ctx(), {});

    // A placeholder id would be confirmable, and would link stock to nothing.
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]!.externalListingId).toBe(VARIANT);
  });
});

describe('reading the store’s tag vocabulary', () => {
  it('returns the tags exactly as the store spells them', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const tags = await connector.listTags!(ctx(), {});

    // `Pokémon` and `Pokemon` are two different tags, and only one of them is
    // wired to a collection. Normalising here would offer the wrong one and
    // produce a product that is visible in the admin and in no collection.
    expect(tags).toEqual(['Pokémon', 'SV04 Paradox Rift']);
  });

  /**
   * A partial vocabulary is a trap: the operator picks from what they are
   * shown, and a tag missing from the list looks exactly like a tag the store
   * does not use.
   */
  it('follows pagination rather than taking the first page for the whole vocabulary', async () => {
    const { client, calls } = mockClient({
      tagPages: [
        {
          productTags: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            edges: [{ node: 'Booster Pack' }],
          },
        },
        {
          productTags: { pageInfo: { hasNextPage: false }, edges: [{ node: 'Elite Trainer Box' }] },
        },
      ],
    });
    const connector = createShopifyConnector({ client });

    const tags = await connector.listTags!(ctx(), {});

    expect(tags).toEqual(['Booster Pack', 'Elite Trainer Box']);
    expect(calls[1]!.variables).toMatchObject({ after: 'cursor-1' });
  });

  it('stops at the ceiling it was given', async () => {
    const { client, calls } = mockClient({
      tagPages: [
        {
          productTags: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            edges: [{ node: 'One' }],
          },
        },
      ],
    });
    const connector = createShopifyConnector({ client });

    const tags = await connector.listTags!(ctx(), { limit: 1 });

    expect(tags).toEqual(['One']);
    // Truncated rather than failed, and without asking for a page it would
    // throw away.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables).toMatchObject({ first: 1 });
  });
});

describe('reading the custom fields a shop models', () => {
  it('offers a single-valued reference field with the ids it accepts', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const fields = await connector.listMetafields!(ctx(), {});
    const game = fields.find((f) => f.key === 'game');

    expect(game).toMatchObject({ owner: 'product', namespace: 'custom', name: 'Game' });
    // Bare id: a single-valued field takes the gid as-is.
    expect(game?.choices).toEqual([{ value: 'gid://shopify/Metaobject/1', label: 'Pokémon' }]);
    expect(game?.unavailable).toBeUndefined();
  });

  /**
   * A `list.` field takes a JSON array. Serialised here, by the side that knows
   * the type, so the core can hand the value straight back without becoming a
   * second place that decides what a list looks like.
   */
  it('serialises a list-typed field as an array', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const fields = await connector.listMetafields!(ctx(), {});

    expect(fields.find((f) => f.key === 'rarity')?.choices).toEqual([
      { value: '["gid://shopify/Metaobject/9"]', label: 'Rare' },
    ]);
  });

  it('leaves a free-text field without choices rather than inventing any', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const number = (await connector.listMetafields!(ctx(), {})).find((f) => f.key === 'number');

    expect(number?.type).toBe('single_line_text_field');
    expect(number?.choices).toBeUndefined();
    expect(number?.unavailable).toBeUndefined();
  });

  /**
   * The type of a reference field is learned from a product that uses it, so a
   * field nothing uses cannot be resolved — and saying so is the point. Reported
   * rather than silently offered with no values, which reads as "this store has
   * none".
   */
  it('reports a field no product uses as unresolved, not as empty', async () => {
    const { client } = mockClient();
    const connector = createShopifyConnector({ client });

    const unused = (await connector.listMetafields!(ctx(), {})).find((f) => f.key === 'unused');

    expect(unused?.choices).toBeUndefined();
    expect(unused?.unavailable).toMatch(/No product uses this field/);
  });

  /**
   * The first version read the fifty most recently updated products and took
   * whatever they happened to carry. That resolved `custom.game` — on 434 of
   * the live shop's 875 products — and missed `shopify.rarity`, on 18, which is
   * a field in real use reported as one nobody uses. Every field is now asked
   * for by name, so the answer does not depend on which products were edited
   * last.
   */
  it('asks for each reference field by name rather than sampling recent products', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    const fields = await connector.listMetafields!(ctx(), {});

    const lookup = calls.find((c) => c.query.includes('HubMetafieldOwners'))!;
    expect(lookup.query).toContain('metafields.custom.game:*');
    expect(lookup.query).toContain('metafields.shopify.rarity:*');
    // Aliased into one request, not one per field.
    expect(calls.filter((c) => c.query.includes('HubMetafieldOwners'))).toHaveLength(1);

    // And the rarely-used field resolves, which is the whole point.
    expect(fields.find((f) => f.key === 'rarity')?.choices).toHaveLength(1);
  });

  /**
   * Measured on the live shop: `metafields.shopify.color-pattern:*` returns
   * nothing where thirty products carry that field, while reading recent
   * products finds it at once. The filter is precise but not exhaustive, so a
   * sweep runs behind it — and a field only the sweep can see must still
   * resolve.
   */
  it('falls back to recent products for a field the filter does not match', async () => {
    const { client, calls } = mockClient({
      // Nothing answers the targeted lookup...
      metafieldOwners: {},
      // ...but a recently updated product plainly carries it.
      metafieldSample: {
        products: {
          nodes: [
            {
              metafields: {
                nodes: [{ namespace: 'custom', key: 'game', reference: { type: 'game' } }],
              },
            },
          ],
        },
      },
    });
    const connector = createShopifyConnector({ client });

    const game = (await connector.listMetafields!(ctx(), {})).find((f) => f.key === 'game');

    expect(game?.choices).toEqual([{ value: 'gid://shopify/Metaobject/1', label: 'Pokémon' }]);
    expect(calls.some((c) => c.query.includes('HubMetafieldSample'))).toBe(true);
  });

  it('skips the sweep when the targeted lookup answered everything', async () => {
    const { client, calls } = mockClient({
      metafieldOwners: {
        'custom.game': { type: 'game', list: false },
        'shopify.rarity': { type: 'shopify--rarity', list: true },
        'custom.unused': { type: 'game', list: false },
      },
    });
    const connector = createShopifyConnector({ client });

    await connector.listMetafields!(ctx(), {});

    // A request that cannot change the answer is a request not worth making.
    expect(calls.some((c) => c.query.includes('HubMetafieldSample'))).toBe(false);
  });

  it('does not go looking for owners of a free-text field', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.listMetafields!(ctx(), {});

    // `custom.number` is a text field: it has no vocabulary to find, so asking
    // who uses it would be a request that could never change the answer.
    expect(calls.find((c) => c.query.includes('HubMetafieldOwners'))!.query).not.toContain(
      'metafields.custom.number',
    );
  });

  /**
   * Without `read_metaobjects` Shopify answers null and **no error**, which is
   * indistinguishable from a shop with no entries. A caller shown an empty list
   * concludes the store has nothing; this one is told to check the scope.
   */
  it('names the missing scope when the vocabulary comes back null', async () => {
    const { client } = mockClient({ metaobjects: {} });
    const connector = createShopifyConnector({ client });

    const game = (await connector.listMetafields!(ctx(), {})).find((f) => f.key === 'game');

    expect(game?.choices).toBeUndefined();
    expect(game?.unavailable).toMatch(/read_metaobjects/);
  });

  it('treats a genuinely empty vocabulary as an answer, not a failure', async () => {
    const { client } = mockClient({ metaobjects: { game: { nodes: [] } } });
    const connector = createShopifyConnector({ client });

    const game = (await connector.listMetafields!(ctx(), {})).find((f) => f.key === 'game');

    expect(game?.choices).toEqual([]);
    expect(game?.unavailable).toBeUndefined();
  });
});

describe('setting custom fields on a created listing', () => {
  const gameField = {
    owner: 'product' as const,
    namespace: 'custom',
    key: 'game',
    type: 'metaobject_reference',
    value: 'gid://shopify/Metaobject/1',
  };

  it('puts product-owned fields on the product it creates', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), {
      sku: CODE,
      title: 'Pikachu ex',
      metafields: [gameField],
    } satisfies CreateListingRequest);

    const create = calls.find((c) => c.query.includes('CreateDraftProduct'));
    expect((create?.variables?.product as Record<string, unknown>).metafields).toEqual([
      { namespace: 'custom', key: 'game', type: 'metaobject_reference', value: gameField.value },
    ]);
  });

  /**
   * Adding a variant must not rewrite the product's description of itself. The
   * operator curated that product; a second condition arriving is not a reason
   * to restate its game, and a wrong value there would be invisible until a
   * collection stopped listing it.
   */
  it('does not touch product fields when adding a variant to an existing product', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), {
      sku: CODE,
      title: 'Pikachu ex',
      siblingListingId: VARIANT,
      metafields: [gameField],
    } satisfies CreateListingRequest);

    expect(calls.some((c) => c.query.includes('CreateDraftProduct'))).toBe(false);
    const variant = (
      calls.find((c) => c.query.includes('CreateProductVariant'))?.variables?.variants as Array<
        Record<string, unknown>
      >
    )[0];
    expect(variant?.metafields).toBeUndefined();
  });

  it('puts variant-owned fields on the variant', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), {
      sku: CODE,
      title: 'Pikachu ex',
      siblingListingId: VARIANT,
      metafields: [{ ...gameField, owner: 'variant', key: 'grade' }],
    } satisfies CreateListingRequest);

    const variant = (
      calls.find((c) => c.query.includes('CreateProductVariant'))?.variables?.variants as Array<
        Record<string, unknown>
      >
    )[0];
    expect(variant?.metafields).toEqual([
      { namespace: 'custom', key: 'grade', type: 'metaobject_reference', value: gameField.value },
    ]);
  });

  it('sends nothing at all when no fields were chosen', async () => {
    const { client, calls } = mockClient();
    const connector = createShopifyConnector({ client });

    await connector.createListing!(ctx(), { sku: CODE, title: 'Pikachu ex' });

    // Absent rather than `[]`: an empty array is a statement about the field,
    // and this is meant to be silence.
    const create = calls.find((c) => c.query.includes('CreateDraftProduct'));
    expect((create?.variables?.product as Record<string, unknown>).metafields).toBeUndefined();
  });
});

/** Quantity is deliberately never populated by enumeration. */
function page_quantity_absent(page: { listings: Array<{ quantity?: number }> }): boolean {
  return page.listings.every((l) => l.quantity === undefined);
}

// The shared contract suite every connector must pass (§10).
runConnectorContractTests({
  connector: createShopifyConnector({ client: mockClient().client }),
  makeCtx: () => ctx(),
  validWebhook: signedOrder(ORDER),
});
