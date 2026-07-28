import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  Connector,
  Ctx,
  DelistRequest,
  LiveListingState,
  NormalizedEvent,
  PushListingRequest,
  PushListingResult,
  UpdatePriceRequest,
  UpdateQuantityRequest,
} from '@hub/connector-sdk';
import {
  createShopifyClient,
  throwOnUserErrors,
  type FetchLike,
  type ShopifyClient,
} from './client';

/**
 * Shopify connector — Admin GraphQL API (TECHNICAL_DESIGN.md §5).
 *
 * The only continuous-sync channel in v1, since TCGPlayer stopped issuing API
 * keys (ADR 0002).
 *
 * **Location scoping.** Shopify inventory is per-location: quantities are set
 * against an (inventoryItem, location) pair, and `inventory_levels/update`
 * fires per location. The core's model has one InventoryItem per SKU with no
 * location dimension (ADR 0001 §5), so this connector pins a single
 * `locationId` from config and ignores every other location on the shop. Stock
 * held elsewhere is invisible to the hub — a stated v1 limitation, not an
 * oversight.
 *
 * **What `externalListingId` holds.** A ProductVariant GID. Quantity updates
 * need the variant's *inventory item* GID instead, which this connector looks
 * up on demand rather than storing, so the core keeps one opaque id per
 * allocation and does not learn Shopify's object graph.
 */

export const SHOPIFY_CONNECTOR_KEY = 'shopify';

const HMAC_HEADER = 'x-shopify-hmac-sha256';

export interface ShopifyConnectorOptions {
  client?: ShopifyClient;
  fetch?: FetchLike;
}

export function createShopifyConnector(options: ShopifyConnectorOptions = {}): Connector {
  const client = options.client ?? createShopifyClient(options.fetch);

  const locationOf = (ctx: Ctx): string => {
    const locationId = String(ctx.config.locationId ?? '').trim();
    if (!locationId) {
      throw new Error(
        'Channel is not configured: locationId is required. Shopify tracks inventory per ' +
          'location, so the hub must be told which one it owns.',
      );
    }
    return locationId;
  };

  return {
    key: SHOPIFY_CONNECTOR_KEY,
    displayName: 'Shopify',
    description: 'Sync listings and receive orders from a Shopify store.',

    configSchema: {
      type: 'object',
      required: ['shopDomain', 'locationId'],
      properties: {
        shopDomain: {
          type: 'string',
          title: 'Shop domain',
          description: 'e.g. my-store.myshopify.com',
          pattern: '^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$',
        },
        locationId: {
          type: 'string',
          title: 'Location',
          description:
            'Which Shopify location this hub manages. Stock at other locations is ignored.',
        },
      },
    },

    // Never in configSchema: the core stores these encrypted and supplies them
    // only inside Ctx.
    secretFields: ['accessToken', 'webhookSecret'],

    capabilities: [
      'listing.push',
      'listing.quantity',
      'listing.price',
      'listing.delist',
      'orders.webhook',
      'reconcile',
    ],

    // Shopify's standard Admin API allowance is 2 requests/second sustained.
    rateLimit: { requestsPerSecond: 2, burst: 10 },

    // -----------------------------------------------------------------------
    // Outbound
    // -----------------------------------------------------------------------

    async pushListing(ctx: Ctx, req: PushListingRequest): Promise<PushListingResult> {
      if (!req.externalListingId) {
        // Creating products from the hub is out of scope for v1: a Shopify
        // product carries titles, images, SEO and publication state that the
        // hub has no opinion about, and inventing them would produce listings
        // no seller wants. Operators map to variants they already created.
        throw new Error(
          'This channel links to existing Shopify variants. Create the product in Shopify, ' +
            'then set the variant id on this allocation.',
        );
      }

      await setQuantity(ctx, req.externalListingId, req.quantity);
      if (req.price !== undefined && req.price !== null) {
        await setPrice(ctx, req.externalListingId, req.price);
      }

      return { externalListingId: req.externalListingId };
    },

    async updateQuantity(ctx: Ctx, req: UpdateQuantityRequest): Promise<void> {
      requireListing(req.externalListingId);
      await setQuantity(ctx, req.externalListingId!, req.quantity);
    },

    async updatePrice(ctx: Ctx, req: UpdatePriceRequest): Promise<void> {
      requireListing(req.externalListingId);
      await setPrice(ctx, req.externalListingId!, req.price);
    },

    /**
     * Delisting sets the advertised quantity to zero rather than deleting
     * anything. §6 is explicit that we never destroy channel-side state; the
     * seller's product, its reviews and its URL are theirs to remove.
     */
    async delist(ctx: Ctx, req: DelistRequest): Promise<void> {
      requireListing(req.externalListingId);
      await setQuantity(ctx, req.externalListingId!, 0);
    },

    // -----------------------------------------------------------------------
    // Inbound
    // -----------------------------------------------------------------------

    /**
     * Verify Shopify's HMAC over the byte-exact raw body.
     *
     * The body must not be parsed or re-serialized first: JSON round-tripping
     * changes whitespace and key order, and the digest then never matches.
     */
    verifyWebhook(ctx: Ctx, headers: Record<string, string>, rawBody: Buffer): boolean {
      const secret = ctx.secrets.webhookSecret;
      if (!secret) return false;

      const presented = headers[HMAC_HEADER] ?? headers[HMAC_HEADER.toLowerCase()];
      if (!presented) return false;

      const expected = createHmac('sha256', secret).update(rawBody).digest();

      let actual: Buffer;
      try {
        actual = Buffer.from(presented, 'base64');
      } catch {
        return false;
      }

      // Length check first: timingSafeEqual throws on a mismatch.
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },

    /**
     * Translate an `orders/create` payload into sale events.
     *
     * One event per line item. The idempotency key is derived from the order
     * and line ids so Shopify's redeliveries — which are routine — cannot
     * decrement stock twice.
     */
    parseWebhook(_ctx: Ctx, rawBody: Buffer): NormalizedEvent[] {
      const order = JSON.parse(rawBody.toString('utf8')) as ShopifyOrder;
      if (!order?.line_items?.length) return [];

      const orderId = String(order.admin_graphql_api_id ?? order.id ?? '');
      const occurredAt = order.created_at ? new Date(order.created_at) : undefined;

      const events: NormalizedEvent[] = [];

      for (const [index, line] of order.line_items.entries()) {
        const variantGid =
          line.admin_graphql_api_variant_id ??
          (line.variant_id ? `gid://shopify/ProductVariant/${line.variant_id}` : null);

        // A line with no variant is a custom or deleted item. It cannot map to
        // an allocation, so skipping it is correct — inventing a listing id
        // would decrement the wrong SKU.
        if (!variantGid || !line.quantity || line.quantity <= 0) continue;

        events.push({
          type: 'sale',
          externalListingId: variantGid,
          quantity: line.quantity,
          orderReference: String(order.name ?? order.id ?? ''),
          occurredAt,
          externalEventId: eventId(orderId, line.id ?? index, variantGid),
        });
      }

      return events;
    },

    // -----------------------------------------------------------------------
    // Reconciliation
    // -----------------------------------------------------------------------

    /**
     * Fetch live quantities for the pinned location.
     *
     * Variants Shopify does not return are omitted rather than reported as
     * quantity zero: a fabricated zero reads as drift and would raise an alert
     * about a listing that may simply have been deleted in Shopify.
     */
    async fetchLiveState(ctx: Ctx, externalListingIds: string[]): Promise<LiveListingState[]> {
      if (externalListingIds.length === 0) return [];

      const locationId = locationOf(ctx);
      const data = await client.request<{ nodes: Array<VariantNode | null> }>(
        ctx,
        LIVE_STATE_QUERY,
        { ids: externalListingIds },
      );

      const states: LiveListingState[] = [];

      for (const node of data.nodes ?? []) {
        if (!node?.id) continue;

        const level = node.inventoryItem?.inventoryLevels?.nodes?.find(
          (l) => l.location?.id === locationId,
        );

        // No level at our location means Shopify is not stocking it there. That
        // is distinct from "zero on hand" and is left out.
        if (!level) continue;

        const available = level.quantities?.find((q) => q.name === 'available')?.quantity;

        states.push({
          externalListingId: node.id,
          quantity: available ?? 0,
          price: node.price ? priceToCents(node.price) : undefined,
          currency: 'USD',
          active: node.inventoryItem?.tracked !== false,
        });
      }

      return states;
    },
  };

  // -------------------------------------------------------------------------

  async function setQuantity(ctx: Ctx, variantGid: string, quantity: number): Promise<void> {
    const locationId = locationOf(ctx);
    const inventoryItemId = await resolveInventoryItemId(ctx, variantGid);

    const data = await client.request<{
      inventorySetQuantities: { userErrors: Array<{ field?: string[]; message: string }> };
    }>(ctx, SET_QUANTITY_MUTATION, {
      input: {
        name: 'available',
        // The hub is the source of truth (§2): it states what the quantity is
        // rather than adjusting by a delta, so a missed webhook self-corrects
        // on the next push instead of compounding.
        reason: 'correction',
        ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId, locationId, quantity }],
      },
    });

    throwOnUserErrors(data.inventorySetQuantities?.userErrors, 'Setting quantity');
  }

  async function setPrice(ctx: Ctx, variantGid: string, cents: number): Promise<void> {
    const productId = await resolveProductId(ctx, variantGid);

    const data = await client.request<{
      productVariantsBulkUpdate: { userErrors: Array<{ field?: string[]; message: string }> };
    }>(ctx, SET_PRICE_MUTATION, {
      productId,
      variants: [{ id: variantGid, price: centsToPrice(cents) }],
    });

    throwOnUserErrors(data.productVariantsBulkUpdate?.userErrors, 'Setting price');
  }

  async function resolveInventoryItemId(ctx: Ctx, variantGid: string): Promise<string> {
    const data = await client.request<{ node: VariantNode | null }>(ctx, VARIANT_QUERY, {
      id: variantGid,
    });

    const id = data.node?.inventoryItem?.id;
    if (!id) {
      throw new Error(`Shopify variant ${variantGid} has no inventory item; it may be deleted.`);
    }
    return id;
  }

  async function resolveProductId(ctx: Ctx, variantGid: string): Promise<string> {
    const data = await client.request<{ node: VariantNode | null }>(ctx, VARIANT_QUERY, {
      id: variantGid,
    });

    const id = data.node?.product?.id;
    if (!id) {
      throw new Error(`Shopify variant ${variantGid} has no product; it may be deleted.`);
    }
    return id;
  }
}

function requireListing(externalListingId: string | null): void {
  if (!externalListingId) {
    throw new Error('This allocation has no Shopify variant id yet.');
  }
}

/**
 * Stable idempotency key.
 *
 * Hashed rather than concatenated so the value stays a bounded length whatever
 * Shopify's ids look like, while remaining a pure function of them.
 */
function eventId(orderId: string, lineId: string | number, variantGid: string): string {
  return createHash('sha256')
    .update(`shopify:${orderId}:${lineId}:${variantGid}`)
    .digest('hex')
    .slice(0, 40);
}

/** Shopify quotes money as a decimal string. Parsed without touching a float. */
export function priceToCents(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const padded = fraction.padEnd(2, '0').slice(0, 2);
  return Number(whole) * 100 + Number(padded);
}

export function centsToPrice(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Wire types and documents
// ---------------------------------------------------------------------------

interface ShopifyOrder {
  id?: number | string;
  name?: string;
  admin_graphql_api_id?: string;
  created_at?: string;
  line_items?: Array<{
    id?: number | string;
    variant_id?: number | string | null;
    admin_graphql_api_variant_id?: string | null;
    quantity?: number;
  }>;
}

interface VariantNode {
  id?: string;
  price?: string;
  product?: { id?: string };
  inventoryItem?: {
    id?: string;
    tracked?: boolean;
    inventoryLevels?: {
      nodes?: Array<{
        location?: { id?: string };
        quantities?: Array<{ name: string; quantity: number }>;
      }>;
    };
  };
}

const VARIANT_QUERY = /* GraphQL */ `
  query VariantForSync($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        price
        product {
          id
        }
        inventoryItem {
          id
          tracked
        }
      }
    }
  }
`;

const LIVE_STATE_QUERY = /* GraphQL */ `
  query LiveListingState($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20) {
            nodes {
              location {
                id
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const SET_QUANTITY_MUTATION = /* GraphQL */ `
  mutation SetInventoryQuantity($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;

const SET_PRICE_MUTATION = /* GraphQL */ `
  mutation SetVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors {
        field
        message
      }
    }
  }
`;
