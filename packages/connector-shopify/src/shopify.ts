import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
      required: ['shopDomain', 'clientId', 'locationId'],
      properties: {
        shopDomain: {
          type: 'string',
          title: 'Shop domain',
          description: 'e.g. my-store.myshopify.com',
          pattern: '^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$',
        },
        clientId: {
          type: 'string',
          title: 'Client ID',
          description:
            'From your app’s Settings page in the Shopify Dev Dashboard. Not a secret — it ' +
            'identifies the app, and the secret below is what proves it is you.',
        },
        locationId: {
          type: 'string',
          title: 'Location',
          description:
            'Which Shopify location this hub manages. Stock at other locations is ignored.',
        },
      },
    },

    /**
     * Never in configSchema: the core stores these encrypted and supplies them
     * only inside Ctx.
     *
     * `clientSecret` replaced the old `accessToken` when Shopify retired legacy
     * custom apps on 1 January 2026 — there is no longer a permanent token to
     * store, only credentials to exchange for a 24-hour one (tokens.ts).
     *
     * `webhookSecret` is optional now. Webhooks an app registers are signed
     * with that app's client secret, so most deployments need only the one
     * value; it stays available for a webhook created by hand with a secret of
     * its own.
     */
    secretFields: ['clientSecret', 'webhookSecret'],

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
      // Shopify signs an app's webhooks with that app's client secret, so a
      // deployment that registered them through the app needs nothing more.
      // An explicit webhookSecret still wins, for a subscription created by
      // hand with a secret of its own.
      const secret = ctx.secrets.webhookSecret || ctx.secrets.clientSecret;
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

  /**
   * Set the advertised quantity at the pinned location.
   *
   * The hub is the source of truth (§2): it states what the quantity is rather
   * than adjusting by a delta, so a missed webhook self-corrects on the next
   * push instead of compounding forever.
   *
   * **This reads before it writes, because Shopify now requires it.**
   * `InventoryQuantityInput.changeFromQuantity` is typed as nullable but
   * rejected at runtime when absent — it replaced the old
   * `ignoreCompareQuantity: true` flag, turning an opt-out into a mandatory
   * compare-and-swap. So the current value has to be read first and handed back
   * as "what I believe you have".
   *
   * That is a better bargain than it looks. The CAS is genuine optimistic
   * concurrency against Shopify: if a customer buys between our read and our
   * write, the set is refused rather than silently overwriting a sale that has
   * already happened. Retrying re-reads, so the second attempt writes against
   * the quantity that sale left behind.
   */
  async function setQuantity(ctx: Ctx, variantGid: string, quantity: number): Promise<void> {
    const locationId = locationOf(ctx);

    // Two attempts. A compare failure means someone else moved the number
    // between our read and our write, and a fresh read is exactly what fixes
    // it; a second failure means contention worth backing off from rather than
    // hammering, which the queue does better than a loop here.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { inventoryItemId, available } = await resolveInventoryState(ctx, variantGid);

      // Already correct. Shopify would refuse a no-op set as a compare failure
      // on some paths, and skipping is honest either way.
      if (available === quantity) return;

      const data = await client.request<{
        inventorySetQuantities: { userErrors: Array<{ field?: string[]; message: string }> };
      }>(ctx, SET_QUANTITY_MUTATION, {
        input: {
          name: 'available',
          reason: 'correction',
          quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: available }],
        },
        /**
         * A fresh key per attempt, not a hash of the operation.
         *
         * A deterministic key would let Shopify replay an earlier result for an
         * identical later push — set 6-from-7 today, and a genuinely new
         * 6-from-7 tomorrow would be swallowed while the key is still in their
         * retention window. That is a silent no-op on someone's stock.
         *
         * The protection a stable key would buy is already covered: every
         * attempt re-reads first, so a request Shopify applied but whose
         * response we lost is caught by the `available === quantity` check
         * above and skipped rather than repeated.
         */
        key: randomUUID(),
      });

      const userErrors = data.inventorySetQuantities?.userErrors ?? [];
      const staleCompare = userErrors.some((e) =>
        /changeFromQuantity|compare|stale|does not match/i.test(e.message),
      );

      if (staleCompare && attempt === 1) {
        ctx.logger.warn(
          `Shopify's quantity moved while pushing ${variantGid}; re-reading and retrying once.`,
        );
        continue;
      }

      throwOnUserErrors(userErrors, 'Setting quantity');
      return;
    }
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

  /**
   * The inventory item behind a variant, plus what Shopify currently shows at
   * our location.
   *
   * Both come from one query because the mandatory compare-and-swap needs them
   * together, and reading them separately would open a window between the two
   * in which the number could move — the very race the compare exists to catch.
   */
  async function resolveInventoryState(
    ctx: Ctx,
    variantGid: string,
  ): Promise<{ inventoryItemId: string; available: number }> {
    const locationId = locationOf(ctx);

    const data = await client.request<{ node: VariantNode | null }>(ctx, VARIANT_QUERY, {
      id: variantGid,
    });

    const inventoryItemId = data.node?.inventoryItem?.id;
    if (!inventoryItemId) {
      throw new Error(`Shopify variant ${variantGid} has no inventory item; it may be deleted.`);
    }

    const level = data.node?.inventoryItem?.inventoryLevels?.nodes?.find(
      (l) => l.location?.id === locationId,
    );

    if (!level) {
      throw new Error(
        `Shopify variant ${variantGid} is not stocked at location ${locationId}. Enable that ` +
          `location for the product, or point this channel at the location that holds it.`,
      );
    }

    // Absent is genuinely zero here, unlike in fetchLiveState: Shopify has told
    // us the item is stocked at this location, so a missing `available` is the
    // count rather than an unanswered question.
    const available = level.quantities?.find((q) => q.name === 'available')?.quantity ?? 0;

    return { inventoryItemId, available };
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

/**
 * Everything a push needs about one variant, in a single round trip.
 *
 * The inventory levels are here because `inventorySetQuantities` requires the
 * current quantity as a compare-and-swap value. Fetching it separately would
 * leave a gap between the read and the write in which the number could move —
 * which is the race the compare is there to catch, so opening one to satisfy it
 * would be self-defeating.
 */
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

/**
 * `@idempotent` is mandatory on this mutation from 2026-07 — Shopify rejects the
 * call outright without it. The key is a fresh UUID per attempt; see the comment
 * at the call site for why that is the honest choice rather than a hash of the
 * operation.
 */
const SET_QUANTITY_MUTATION = /* GraphQL */ `
  mutation SetInventoryQuantity($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
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
