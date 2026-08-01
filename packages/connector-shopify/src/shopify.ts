import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ChannelListing,
  ChannelListingPage,
  Connector,
  CreateListingRequest,
  CreateListingResult,
  Ctx,
  DelistRequest,
  EnumerateListingsRequest,
  ListMetafieldsRequest,
  ListTagsRequest,
  ListingMetafieldChoice,
  ListingMetafieldDefinition,
  LiveListingState,
  NormalizedEvent,
  PushListingRequest,
  PushListingResult,
  UpdateListingSkuRequest,
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

    /**
     * Only `clientSecret` is needed to run a Shopify channel. Leaving
     * `webhookSecret` in the required set told a working channel it was "not
     * connected yet", and sent operators looking in the Shopify Dev Dashboard
     * for a value that is not issued there.
     */
    optionalSecretFields: ['webhookSecret'],

    capabilities: [
      'listing.push',
      'listing.create',
      'listing.quantity',
      'listing.price',
      'listing.delist',
      'orders.webhook',
      'reconcile',
      'listing.enumerate',
      'listing.tags',
      'listing.metafields',
      'listing.sku',
    ],

    // Shopify's standard Admin API allowance is 2 requests/second sustained.
    rateLimit: { requestsPerSecond: 2, burst: 10 },

    // -----------------------------------------------------------------------
    // Outbound
    // -----------------------------------------------------------------------

    async pushListing(ctx: Ctx, req: PushListingRequest): Promise<PushListingResult> {
      if (!req.externalListingId) {
        // Still refuses to create, and the reason has not changed: a Shopify
        // product carries titles, images, SEO and publication state that a
        // `PushListingRequest` does not carry and that this connector must not
        // invent. Creation is `listing.create`, where the operator supplies
        // them — a push is for a listing that already exists.
        throw new Error(
          'This channel links to existing Shopify variants. Create the listing first — ' +
            'from the ledger, or by hand in Shopify — then set the variant id on this allocation.',
        );
      }

      await setQuantity(ctx, req.externalListingId, req.quantity);
      if (req.price !== undefined && req.price !== null) {
        await setPrice(ctx, req.externalListingId, req.price);
      }

      return { externalListingId: req.externalListingId };
    },

    /**
     * Bring a variant into existence, as a **draft**.
     *
     * Three paths, tried in this order, and the order is the safety property:
     *
     * 1. **The SKU already exists** → return that variant untouched. Creating a
     *    second product for a card the operator already listed is the failure
     *    this prevents, and unlike most mistakes here it is visible to
     *    customers. Checked first so a re-run of the same selection is a no-op
     *    rather than a duplicate.
     * 2. **A sibling variant was named** → add a variant to *its* product. This
     *    is how a card ends up as one product with a Condition option rather
     *    than one product per condition.
     * 3. **Neither** → a new product.
     *
     * `status: DRAFT` is hard-coded rather than a request field. Nothing should
     * become buyable because a background job ran, and a parameter is an
     * invitation for some future caller to pass ACTIVE. Publication stays the
     * seller's decision, in Shopify, deliberately.
     *
     * No quantity is set here either. Stock flows through `listing.quantity`
     * like everything else, so a listing created now and pushed a moment later
     * follows exactly one code path into the ledger's numbers (rule 5).
     * `inventoryItem.tracked` is set, because an untracked variant silently
     * ignores every quantity push that follows.
     */
    async createListing(ctx: Ctx, req: CreateListingRequest): Promise<CreateListingResult> {
      const sku = req.sku.trim();
      if (!sku) {
        // Without one there is no idempotency key, so a retry would duplicate.
        throw new Error('Refusing to create a Shopify listing with no SKU.');
      }

      const title = req.title.trim();
      if (!title) {
        throw new Error('Refusing to create a Shopify listing with no title.');
      }

      const existing = await findVariantBySku(ctx, sku);
      if (existing) {
        return { externalListingId: existing, createdProduct: false, alreadyExisted: true };
      }

      if (req.siblingListingId) {
        const productId = await resolveProductId(ctx, req.siblingListingId);
        const externalListingId = await addVariant(ctx, productId, req, sku);
        return { externalListingId, createdProduct: false, alreadyExisted: false };
      }

      const { productId, variantId } = await createDraftProduct(ctx, req, title);

      // Shopify has changed whether `productCreate` materialises a variant for
      // a declared option more than once, and this connector has already been
      // caught out by three schema changes in one sitting. So handle both: fill
      // in the variant it made, or create one if it made none.
      const externalListingId = variantId
        ? await fillVariant(ctx, productId, variantId, req, sku)
        : await addVariant(ctx, productId, req, sku);

      return { externalListingId, createdProduct: true, alreadyExisted: false };
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
     * Write the hub's identifier into the variant's SKU field.
     *
     * Shopify keeps a variant's SKU on its **inventory item**, not on the variant
     * itself, so this goes through `productVariantsBulkUpdate` with
     * `inventoryItem: { sku }` — the same mutation the price write already uses,
     * and the same `write_products` scope the connector already asks for.
     *
     * Verbatim, with no normalising: the matcher's `certain` path is an equality
     * test against this value, and a connector that tidied it would quietly turn
     * tomorrow's exact match back into a name guess.
     */
    async updateListingSku(ctx: Ctx, req: UpdateListingSkuRequest): Promise<void> {
      const sku = req.sku.trim();
      if (!sku) {
        // Blanking a seller's SKU is not something the core ever means to ask
        // for, and Shopify would accept it.
        throw new Error('Refusing to write an empty SKU.');
      }

      const productId = await resolveProductId(ctx, req.externalListingId);

      const data = await client.request<{
        productVariantsBulkUpdate: { userErrors: Array<{ field?: string[]; message: string }> };
      }>(ctx, SET_SKU_MUTATION, {
        productId,
        variants: [{ id: req.externalListingId, inventoryItem: { sku } }],
      });

      throwOnUserErrors(data.productVariantsBulkUpdate?.userErrors, 'Setting SKU');
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

    // -----------------------------------------------------------------------
    // Discovery
    // -----------------------------------------------------------------------

    /**
     * Walk the store's product variants so they can be matched to inventory.
     *
     * **Deliberately does not report quantity.** Fetching inventory levels for
     * every variant on a page would multiply the query cost by the page size and
     * run into Shopify's calculated-cost limit on any real catalogue — and
     * matching does not need it. Quantity for a listing we already know about is
     * what `fetchLiveState` is for; this answers the different question of what
     * exists at all.
     *
     * `sku` and `barcode` are carried because they are the only fields that can
     * make a match *certain* rather than probable. Most TCG stores populate
     * neither, so both are optional and the matcher treats them as evidence.
     */
    async enumerateListings(ctx: Ctx, req: EnumerateListingsRequest): Promise<ChannelListingPage> {
      // Shopify caps a connection page at 250. Asking for more is an error
      // rather than a truncation, so it is clamped here instead.
      const first = Math.min(Math.max(req.limit ?? 100, 1), 250);

      const data = await client.request<{
        productVariants?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          nodes?: Array<EnumeratedVariantNode | null>;
        };
      }>(ctx, ENUMERATE_LISTINGS_QUERY, {
        first,
        after: req.cursor ?? null,
        // Shopify's own full-text search over variants. Best-effort: it narrows
        // the page, and the core does not rely on it having done so.
        query: req.search?.trim() ? req.search.trim() : null,
      });

      const connection = data.productVariants;
      const listings: ChannelListing[] = [];

      for (const node of connection?.nodes ?? []) {
        // A variant with no id cannot be linked to anything, and a placeholder
        // would be worse than an omission — it would be confirmable.
        if (!node?.id) continue;

        const listing: ChannelListing = {
          externalListingId: node.id,
          // `displayName` is already "Product - Variant", which is what the
          // operator is being asked to recognise.
          title: node.displayName ?? node.product?.title ?? node.title ?? node.id,
        };

        if (node.sku) listing.sku = node.sku;
        if (node.barcode) listing.barcode = node.barcode;

        if (node.price) {
          listing.price = priceToCents(node.price);
          listing.currency = 'USD';
        }

        // Shopify's product status, not our allocation status: a draft or
        // archived product is not on sale, and proposing it as a live listing
        // would invite the operator to link stock to something no one can buy.
        if (node.product?.status) listing.active = node.product.status === 'ACTIVE';

        listings.push(listing);
      }

      const cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;

      // Only when there is genuinely another page *and* a cursor to ask with.
      // Returning a cursor on the last page walks the caller in circles.
      return cursor ? { listings, nextCursor: cursor } : { listings };
    },

    /**
     * Every tag the store's products already carry.
     *
     * Paginated internally rather than by the caller, because a partial
     * vocabulary is a trap: the operator picks from what they are shown, and a
     * tag missing from the list looks exactly like a tag the store does not
     * use. `productTags` is a plain string connection, so a few hundred tags
     * cost a handful of cheap requests.
     *
     * Returned as Shopify spells them. `Pokémon` and `Pokemon` are two
     * different tags here and only one of them is wired to a collection, so
     * normalising would quietly offer the wrong one.
     */
    async listTags(ctx: Ctx, req: ListTagsRequest): Promise<string[]> {
      const ceiling = Math.max(req.limit ?? 500, 1);
      const tags: string[] = [];
      let cursor: string | null = null;

      while (tags.length < ceiling) {
        const first = Math.min(ceiling - tags.length, 250);

        const data: {
          productTags?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            edges?: Array<{ node?: string | null } | null>;
          };
        } = await client.request(ctx, PRODUCT_TAGS_QUERY, { first, after: cursor });

        for (const edge of data.productTags?.edges ?? []) {
          if (edge?.node) tags.push(edge.node);
        }

        const pageInfo = data.productTags?.pageInfo;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }

      return tags;
    },

    /**
     * The custom fields this shop models, and what each will accept.
     *
     * ## Three queries, because the obvious one is out of reach
     *
     * A metafield definition names its vocabulary as a
     * `metaobject_definition_id` validation, and turning that into the `type`
     * string `metaobjects()` wants needs `read_metaobject_definitions`. That is
     * a second scope for one string, so it is not used. The type is discovered
     * instead from **a product that already carries the field** — which needs
     * only `read_metaobjects`, and has the side benefit that a field no product
     * uses is reported as unresolved rather than guessed at.
     *
     * ## The silence this exists to break
     *
     * Without `read_metaobjects` Shopify answers `null` and **no error** —
     * indistinguishable from a shop that has defined no entries. Every failure
     * below therefore becomes an `unavailable` reason naming the scope, never
     * an empty `choices`.
     */
    async listMetafields(
      ctx: Ctx,
      req: ListMetafieldsRequest,
    ): Promise<ListingMetafieldDefinition[]> {
      const perVocabulary = Math.min(Math.max(req.limit ?? 250, 1), 250);

      const owners = [
        { owner: 'product' as const, ownerType: 'PRODUCT' },
        { owner: 'variant' as const, ownerType: 'PRODUCTVARIANT' },
      ];

      const definitions: ListingMetafieldDefinition[] = [];
      for (const { owner, ownerType } of owners) {
        const data = await client.request<{
          metafieldDefinitions?: { nodes?: MetafieldDefinitionNode[] };
        }>(ctx, METAFIELD_DEFINITIONS_QUERY, { ownerType });

        for (const node of data.metafieldDefinitions?.nodes ?? []) {
          if (!node?.namespace || !node.key || !node.type?.name) continue;
          definitions.push({
            owner,
            namespace: node.namespace,
            key: node.key,
            type: node.type.name,
            name: node.name ?? `${node.namespace}.${node.key}`,
          });
        }
      }

      const referenceTypes = await discoverMetaobjectTypes(
        ctx,
        definitions.filter((d) => d.type.includes('metaobject_reference')),
      );
      const vocabularies = new Map<string, ListingMetafieldChoice[] | undefined>();

      for (const definition of definitions) {
        if (!definition.type.includes('metaobject_reference')) continue;

        const metaobjectType = referenceTypes.get(`${definition.namespace}.${definition.key}`);
        if (!metaobjectType) {
          definition.unavailable =
            'No product uses this field yet, so its vocabulary could not be found. Set it by ' +
            'hand on one product first.';
          continue;
        }

        if (!vocabularies.has(metaobjectType)) {
          vocabularies.set(
            metaobjectType,
            await readVocabulary(ctx, metaobjectType, perVocabulary),
          );
        }

        const entries = vocabularies.get(metaobjectType);
        if (!entries) {
          definition.unavailable =
            `This shop did not return the "${metaobjectType}" entries this field references. ` +
            'The app usually needs the read_metaobjects scope.';
          continue;
        }

        // A list-typed field takes a JSON array, a single-valued one takes the
        // id bare. Serialised here so the core can hand the value straight back
        // without knowing which it is.
        const isList = definition.type.startsWith('list.');
        definition.choices = entries.map((entry) => ({
          label: entry.label,
          value: isList ? JSON.stringify([entry.value]) : entry.value,
        }));
      }

      return definitions;
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

  /**
   * The variant carrying this SKU, or undefined.
   *
   * The idempotency check for creation. Shopify's variant search takes
   * `sku:<value>`, and our codes contain colons — which that syntax also uses
   * as a field separator — so the value is quoted. Without the quotes
   * `sku:tcgcsv:704143:SEALED:NORMAL:EN` parses as a field named `tcgcsv` and
   * matches nothing, which would read as "not there" and duplicate the product.
   */
  async function findVariantBySku(ctx: Ctx, sku: string): Promise<string | undefined> {
    const data = await client.request<{
      productVariants: { nodes: Array<{ id?: string; sku?: string | null }> };
    }>(ctx, FIND_VARIANT_BY_SKU_QUERY, { query: `sku:"${escapeSearchValue(sku)}"` });

    // Shopify's search is not an exact-match engine, so the equality is
    // re-checked here rather than trusted. A near-match returned as an exact
    // one would hand back somebody else's variant to be linked.
    return data.productVariants?.nodes?.find((node) => node.sku === sku)?.id;
  }

  async function createDraftProduct(
    ctx: Ctx,
    req: CreateListingRequest,
    title: string,
  ): Promise<{ productId: string; variantId?: string }> {
    const product: Record<string, unknown> = { title, status: 'DRAFT' };

    if (req.description) product.descriptionHtml = req.description;
    if (req.vendor) product.vendor = req.vendor;
    // Verbatim, and only when given. The core never derives these: the
    // operator's collections are all smart collections keyed on a single tag,
    // so a tag this hub invented would put the product in no collection at all
    // — present in the admin, invisible in the shop.
    if (req.tags && req.tags.length > 0) product.tags = [...req.tags];
    // Product-owned fields only, and only here — `addVariant` deliberately does
    // not set them, because a product the operator already curated must not
    // have its description of itself rewritten by adding a variant to it.
    const productMetafields = metafieldsFor(req, 'product');
    if (productMetafields) product.metafields = productMetafields;
    if (req.optionName && req.optionValue) {
      product.productOptions = [{ name: req.optionName, values: [{ name: req.optionValue }] }];
    }

    const variables: Record<string, unknown> = { product };
    if (req.imageUrl)
      variables.media = [{ originalSource: req.imageUrl, mediaContentType: 'IMAGE' }];

    const data = await client.request<{
      productCreate: {
        product?: { id?: string; variants?: { nodes?: Array<{ id?: string }> } };
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(ctx, CREATE_PRODUCT_MUTATION, variables);

    throwOnUserErrors(data.productCreate?.userErrors, 'Creating product');

    const productId = data.productCreate?.product?.id;
    if (!productId) {
      throw new Error('Shopify reported no product after productCreate; nothing was linked.');
    }

    const variantId = data.productCreate.product?.variants?.nodes?.[0]?.id;
    return variantId ? { productId, variantId } : { productId };
  }

  /** Add a variant to an existing product. */
  async function addVariant(
    ctx: Ctx,
    productId: string,
    req: CreateListingRequest,
    sku: string,
  ): Promise<string> {
    const variant: Record<string, unknown> = {
      inventoryItem: { sku, tracked: true },
    };

    if (req.price !== undefined) variant.price = centsToPrice(req.price);
    if (req.optionName && req.optionValue) {
      variant.optionValues = [{ optionName: req.optionName, name: req.optionValue }];
    }
    if (req.imageUrl) variant.mediaSrc = [req.imageUrl];

    const variantMetafields = metafieldsFor(req, 'variant');
    if (variantMetafields) variant.metafields = variantMetafields;

    const data = await client.request<{
      productVariantsBulkCreate: {
        productVariants?: Array<{ id?: string }>;
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    }>(ctx, CREATE_VARIANT_MUTATION, { productId, variants: [variant] });

    throwOnUserErrors(data.productVariantsBulkCreate?.userErrors, 'Creating variant');

    const id = data.productVariantsBulkCreate?.productVariants?.[0]?.id;
    if (!id) {
      throw new Error('Shopify reported no variant after productVariantsBulkCreate.');
    }
    return id;
  }

  /**
   * Put the SKU and price onto a variant `productCreate` made for us.
   *
   * `optionValues` is deliberately not sent: the variant already holds the
   * option value the product was created with, and restating it here is how a
   * second option value gets created by accident.
   */
  async function fillVariant(
    ctx: Ctx,
    productId: string,
    variantId: string,
    req: CreateListingRequest,
    sku: string,
  ): Promise<string> {
    const variant: Record<string, unknown> = {
      id: variantId,
      inventoryItem: { sku, tracked: true },
    };
    if (req.price !== undefined) variant.price = centsToPrice(req.price);

    const variantMetafields = metafieldsFor(req, 'variant');
    if (variantMetafields) variant.metafields = variantMetafields;

    const data = await client.request<{
      productVariantsBulkUpdate: { userErrors: Array<{ field?: string[]; message: string }> };
    }>(ctx, SET_SKU_MUTATION, { productId, variants: [variant] });

    throwOnUserErrors(data.productVariantsBulkUpdate?.userErrors, 'Setting SKU on new variant');
    return variantId;
  }

  /**
   * Which metaobject type each reference field points at, learned from use.
   *
   * **One product that carries the field, per field, asked for by name.** The
   * first version sampled the fifty most recently updated products and read
   * whatever they happened to have, which resolved `custom.game` (on 434 of
   * this shop's 875 products) and silently missed `shopify.rarity` (on 18) —
   * reporting a field in real use as one nobody uses. Sampling makes the answer
   * depend on luck; `metafields.<namespace>.<key>:*` asks the question directly.
   *
   * Batched through GraphQL aliases so a shop with twenty reference fields
   * costs one round trip rather than twenty. {@link OWNER_LOOKUP_BATCH} keeps a
   * single request inside Shopify's calculated-cost budget.
   */
  async function discoverMetaobjectTypes(
    ctx: Ctx,
    fields: ReadonlyArray<{ namespace: string; key: string }>,
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();

    for (let i = 0; i < fields.length; i += OWNER_LOOKUP_BATCH) {
      const batch = fields.slice(i, i + OWNER_LOOKUP_BATCH);

      // Aliases are generated here, never taken from the shop. The *filter* is
      // shop data and goes through the same escaping as the SKU search — a
      // connector must not assume its inputs are tame just because they came
      // back from the platform a moment ago.
      const query =
        'query HubMetafieldOwners {\n' +
        batch
          .map(
            (field, index) =>
              `  f${index}: products(first: 1, query: "${escapeSearchValue(
                `metafields.${field.namespace}.${field.key}:*`,
              )}") { nodes { metafields(first: 30) { nodes { namespace key ` +
              'reference { ... on Metaobject { type } } ' +
              'references(first: 1) { nodes { ... on Metaobject { type } } } } } } }',
          )
          .join('\n') +
        '\n}';

      const data = await client.request<
        Record<
          string,
          { nodes?: Array<{ metafields?: { nodes?: SampledMetafieldNode[] } } | null> }
        >
      >(ctx, query, {});

      for (const [index, field] of batch.entries()) {
        const wanted = `${field.namespace}.${field.key}`;
        for (const product of data[`f${index}`]?.nodes ?? []) {
          for (const held of product?.metafields?.nodes ?? []) {
            if (`${held?.namespace}.${held?.key}` !== wanted) continue;

            // `reference` is null on a list-typed field and `references` is
            // null on a single one, so both are asked for and either answers.
            const type = held?.reference?.type ?? held?.references?.nodes?.[0]?.type;
            if (type) found.set(wanted, type);
          }
        }
      }
    }

    // Then a sweep of recent products, for anything the filter did not match.
    //
    // Measured, not defensive: `metafields.shopify.color-pattern:*` returns
    // nothing on a shop where thirty products carry that field, while a plain
    // read of recent products finds it immediately. The filter is precise but
    // not exhaustive, and the sweep is exhaustive but lucky — so both run, and
    // one request covers every field the first pass missed.
    if (found.size < fields.length) {
      const data = await client.request<{
        products?: { nodes?: Array<{ metafields?: { nodes?: SampledMetafieldNode[] } } | null> };
      }>(ctx, METAFIELD_SAMPLE_QUERY, { first: METAFIELD_SAMPLE_SIZE });

      for (const product of data.products?.nodes ?? []) {
        for (const held of product?.metafields?.nodes ?? []) {
          if (!held?.namespace || !held.key) continue;

          const name = `${held.namespace}.${held.key}`;
          if (found.has(name)) continue;

          const type = held.reference?.type ?? held.references?.nodes?.[0]?.type;
          if (type) found.set(name, type);
        }
      }
    }

    return found;
  }

  /** Every entry of one metaobject type, or undefined when they cannot be read. */
  async function readVocabulary(
    ctx: Ctx,
    type: string,
    limit: number,
  ): Promise<ListingMetafieldChoice[] | undefined> {
    const data = await client.request<{
      metaobjects?: { nodes?: Array<{ id?: string; displayName?: string } | null> } | null;
    }>(ctx, METAOBJECT_ENTRIES_QUERY, { type, first: limit });

    // Null, not empty: the scope is missing. An empty list is a real answer and
    // must not be reported as a failure.
    if (!data.metaobjects) return undefined;

    const choices: ListingMetafieldChoice[] = [];
    for (const node of data.metaobjects.nodes ?? []) {
      if (node?.id) choices.push({ value: node.id, label: node.displayName ?? node.id });
    }
    return choices;
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

/**
 * The metafields for one owner, in Shopify's input shape, or undefined.
 *
 * Undefined rather than an empty array on purpose: sending `metafields: []`
 * is a statement about the field, and this is meant to be silence.
 *
 * Values are passed through exactly as the core supplied them — they came from
 * `listMetafields`, already serialised for their own type, and a connector that
 * re-encoded them here would be the second place that decides what a list looks
 * like.
 */
function metafieldsFor(
  req: CreateListingRequest,
  owner: 'product' | 'variant',
): Array<{ namespace: string; key: string; type: string; value: string }> | undefined {
  const fields = (req.metafields ?? [])
    .filter((field) => field.owner === owner)
    .map(({ namespace, key, type, value }) => ({ namespace, key, type, value }));

  return fields.length > 0 ? fields : undefined;
}

/**
 * Quote a value for Shopify's search syntax.
 *
 * **Backslashes first, then quotes, and the order is the whole point.** Doing
 * quotes alone leaves the escape character itself unescaped, so a value ending
 * in `\` escapes the closing quote this function just added and the rest of the
 * query becomes part of the string — the search then means something the caller
 * never asked for. CodeQL flagged exactly that (`js/incomplete-sanitization`)
 * on the first version of this, and was right to.
 *
 * Reachable even though a hub SKU code cannot contain either character:
 * `createListing` takes `sku` as an opaque string from the core, and a
 * connector must not assume its caller validated anything.
 */
function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

/** Only what a matcher can use. See `enumerateListings` on why quantity is absent. */
interface EnumeratedVariantNode {
  id?: string;
  title?: string;
  displayName?: string;
  sku?: string;
  barcode?: string;
  price?: string;
  product?: { title?: string; status?: string };
}

const ENUMERATE_LISTINGS_QUERY = /* GraphQL */ `
  query EnumerateListings($first: Int!, $after: String, $query: String) {
    productVariants(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        displayName
        sku
        barcode
        price
        product {
          title
          status
        }
      }
    }
  }
`;

/**
 * `productTags` is an edge/node string connection, not a `nodes` list — one of
 * the few connections in this schema that is, so the shape here deliberately
 * does not mirror the queries above it.
 */
const PRODUCT_TAGS_QUERY = /* GraphQL */ `
  query HubProductTags($first: Int!, $after: String) {
    productTags(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node
      }
    }
  }
`;

/**
 * How many "who uses this field" lookups to alias into one request.
 *
 * Each is a `products(first: 1)` with its metafields, so the calculated cost of
 * a batch this size stays well inside Shopify's bucket while a shop with twenty
 * reference fields still resolves in a single round trip.
 */
const OWNER_LOOKUP_BATCH = 20;

/** Recent products read in the second pass, for fields the filter does not match. */
const METAFIELD_SAMPLE_SIZE = 50;

interface MetafieldDefinitionNode {
  name?: string;
  namespace?: string;
  key?: string;
  type?: { name?: string };
}

interface SampledMetafieldNode {
  namespace?: string;
  key?: string;
  reference?: { type?: string } | null;
  references?: { nodes?: Array<{ type?: string } | null> } | null;
}

const METAFIELD_DEFINITIONS_QUERY = /* GraphQL */ `
  query HubMetafieldDefinitions($ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(ownerType: $ownerType, first: 250) {
      nodes {
        name
        namespace
        key
        type {
          name
        }
      }
    }
  }
`;

const METAFIELD_SAMPLE_QUERY = /* GraphQL */ `
  query HubMetafieldSample($first: Int!) {
    products(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        metafields(first: 30) {
          nodes {
            namespace
            key
            reference {
              ... on Metaobject {
                type
              }
            }
            references(first: 1) {
              nodes {
                ... on Metaobject {
                  type
                }
              }
            }
          }
        }
      }
    }
  }
`;

const METAOBJECT_ENTRIES_QUERY = /* GraphQL */ `
  query HubMetaobjectEntries($type: String!, $first: Int!) {
    metaobjects(type: $type, first: $first) {
      nodes {
        id
        displayName
      }
    }
  }
`;

const FIND_VARIANT_BY_SKU_QUERY = /* GraphQL */ `
  query FindVariantBySku($query: String!) {
    productVariants(first: 5, query: $query) {
      nodes {
        id
        sku
      }
    }
  }
`;

const CREATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation CreateDraftProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        variants(first: 1) {
          nodes {
            id
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_VARIANT_MUTATION = /* GraphQL */ `
  mutation CreateProductVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SET_SKU_MUTATION = /* GraphQL */ `
  mutation SetVariantSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors {
        field
        message
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
