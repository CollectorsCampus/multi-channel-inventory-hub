/**
 * What a connector can do — TECHNICAL_DESIGN.md §5, revised by ADR 0002.
 *
 * Capabilities are *declared*, never assumed. The core degrades around them:
 * a connector without `orders.webhook` gets scheduled for `orders.poll`
 * instead, and one with neither is a manual channel whose freshness depends on
 * a human doing a file round trip.
 *
 * §5's original set assumed every connector was a live HTTP client. That
 * assumption died with TCGPlayer's developer programme (ADR 0002), so the set
 * now spans three transports:
 *
 *   - API      the connector talks to a platform in real time
 *   - webhook  the platform calls us
 *   - file     an operator moves data by hand, via export/import
 *
 * File capabilities are not a TCGPlayer special case. Every marketplace without
 * a usable API becomes reachable through the same mechanism, which is worth
 * more to this project than any single connector.
 */

export const CAPABILITIES = [
  // Note: there is no `catalog.search`. Product lookup is not a channel
  // concern — it has no listings, no orders and no place in the allocation
  // loop — so it lives behind the separate `CatalogSource` interface in
  // catalog.ts. A package may export both when a platform does both.

  // --- outbound, live -------------------------------------------------------
  /** Create or update a listing. */
  'listing.push',

  /**
   * Bring a listing into existence that the platform does not have yet.
   *
   * Separate from `listing.push`, which syncs stock and price to a listing that
   * already exists and carries nothing a platform needs in order to *create*
   * one — no title, no image, no vendor. `connector-shopify`'s `pushListing`
   * refuses to create for exactly that reason: "a Shopify product carries
   * titles, images, SEO and publication state the hub has no opinion about, and
   * inventing them would produce listings no seller wants."
   *
   * This capability does not delete that objection; it answers it, by making
   * the content an explicit input the operator supplies rather than something
   * the hub invents.
   *
   * **Never a side effect.** A thirteen-hundred-row import must not become
   * thirteen hundred storefront products, so the core only calls this for
   * items an operator selected. Connectors must create as a **draft** or the
   * platform's nearest unpublished equivalent: nothing should become buyable
   * because a background job ran.
   */
  'listing.create',
  /** Change a listing's price. */
  'listing.price',
  /** Change a listing's advertised quantity. */
  'listing.quantity',
  /** Remove a listing. */
  'listing.delist',

  // --- inbound, live --------------------------------------------------------
  /** The platform posts order events to us. */
  'orders.webhook',
  /** We poll the platform for order events. */
  'orders.poll',

  // --- reconciliation -------------------------------------------------------
  /** Fetch live listing state for drift detection. */
  'reconcile',

  /**
   * Write our identifier into the channel's own seller-SKU field.
   *
   * Separate from `listing.push` because it is not part of syncing stock: it
   * stamps the platform's record so the *mapping* survives outside this
   * database. A hub rebuilt from scratch can then re-derive every link from the
   * channel itself instead of asking the operator to match 1,300 items again.
   *
   * **Destructive where the field is already in use.** A seller SKU usually
   * means something to its owner — a supplier code, a POS reference — so a core
   * that calls this without being asked to would be overwriting business data.
   * Callers must make it opt-in.
   */
  'listing.sku',

  // --- discovery ------------------------------------------------------------
  /**
   * Enumerate the listings that already exist on the channel.
   *
   * Distinct from `reconcile`, and the distinction is the whole point.
   * `fetchLiveState` answers "what does the channel say about *these* ids",
   * which presupposes we already hold them. Nothing answered "what are you
   * selling that I have never heard of" — so an operator arriving with a
   * populated storefront had no path from it to an allocation except typing a
   * variant id per item, by hand, forever.
   */
  'listing.enumerate',

  /**
   * Read back the tag vocabulary the channel already uses.
   *
   * Only worth declaring on a platform where a tag *does* something. On the
   * store this was built for, all 23 collections are smart collections keyed on
   * a single tag equality rule, so a tag is the only thing that puts a product
   * in front of a customer — and a product created with a tag nobody uses
   * exists in the admin and appears nowhere in the shop, which is a failure
   * that reports nothing.
   *
   * The hub therefore never derives a tag: catalogue names are not the store's
   * tags (`Pokemon` against `Pokémon`, `Magic` against `Magic: The Gathering`).
   * This exists so an operator can pick from what the store actually says
   * rather than retype it from memory.
   */
  'listing.tags',

  /**
   * Read back the custom fields a channel models, and their vocabularies.
   *
   * The same argument as `listing.tags`, one level more structured. A store
   * that already describes its products — `custom.game` on 434 of them,
   * `custom.set` on 142 — has a vocabulary the hub must write *into* rather
   * than beside: a second, hub-owned "game" field would be a second answer to
   * a question the store already answers, invisible to the theme that reads
   * the first one.
   *
   * Values are opaque to the core. On Shopify these fields reference
   * metaobjects, so the value is a GID that means nothing without the store —
   * which is exactly why the operator picks it from what the connector reports
   * and the hub never derives it.
   */
  'listing.metafields',

  /**
   * Replace the image of a listing this hub already drives.
   *
   * Separate from `listing.push`, which syncs stock and price, and from
   * `listing.create`, which supplies an image only at birth: this exists for
   * the listing whose image has *improved since* — a catalogue that upgraded
   * its resolution, a corrected scan. The core sends the catalogue's current
   * image URL and the connector replaces what the platform holds.
   *
   * **Replacement is destructive of what it replaces**, so the core only calls
   * this for listings an operator explicitly selected — never as a side effect
   * of a push or a sweep. Connectors should replace the listing's existing
   * imagery rather than accumulate: a storefront gallery showing the old
   * low-resolution image beside the new one is worse than either alone.
   */
  'listing.image',

  /**
   * Read back the sales channels (publications) a product can be published to,
   * and publish a newly created product to the ones the operator chose.
   *
   * One capability for both halves on purpose: a connector that can enumerate a
   * store's publications is the same one that can publish to them, and the read
   * exists only to feed the write. The values are opaque publication ids —
   * `gid://shopify/Publication/…` on Shopify — meaningful only inside that shop,
   * so the operator picks from what the connector reports and the hub never
   * derives one, exactly like a tag or a metafield.
   *
   * **Publishing is product-owned.** A connector honours
   * {@link CreateListingRequest.publications} only when it *creates a product* —
   * adding a variant to a product the operator already curated must not rewrite
   * which channels that product is on. Publishing a draft attaches it to the
   * channel without making it buyable; visibility still waits on the product
   * being made active.
   */
  'listing.publications',

  // --- file transport (ADR 0002) --------------------------------------------
  /** Render desired listings to a file for the operator to upload. */
  'listing.export',
  /** Parse an operator-supplied order export into order events. */
  'orders.import',
  /** Parse an operator-supplied inventory export into live listing state. */
  'inventory.import',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The method each capability obliges a connector to implement.
 *
 * This is the contract that makes "capabilities are declared" enforceable
 * rather than aspirational: declaring `listing.quantity` without implementing
 * `updateQuantity` is a defect the registry rejects at startup, instead of a
 * crash during the first sale of the night.
 */
export const CAPABILITY_METHODS = {
  'listing.push': 'pushListing',
  'listing.create': 'createListing',
  'listing.price': 'updatePrice',
  'listing.quantity': 'updateQuantity',
  'listing.delist': 'delist',
  'orders.webhook': 'parseWebhook',
  'orders.poll': 'pollChanges',
  reconcile: 'fetchLiveState',
  'listing.enumerate': 'enumerateListings',
  'listing.tags': 'listTags',
  'listing.metafields': 'listMetafields',
  'listing.publications': 'listPublications',
  'listing.image': 'updateListingImage',
  'listing.sku': 'updateListingSku',
  'listing.export': 'exportListings',
  'orders.import': 'importOrders',
  'inventory.import': 'importInventory',
} as const satisfies Record<Capability, string>;

/**
 * How fresh a channel's data can possibly be.
 *
 * Derived from capabilities rather than configured, so it cannot disagree with
 * what the connector actually supports. The core needs it in two places: the
 * UI must not present a manual channel as if it were live, and reconciliation
 * must not report a stale manual channel as drift — its numbers are *expected*
 * to lag until someone does the round trip.
 */
export type SyncMode = 'continuous' | 'polled' | 'manual' | 'outbound-only';

export function syncModeOf(capabilities: readonly Capability[]): SyncMode {
  const has = (c: Capability) => capabilities.includes(c);

  if (has('orders.webhook')) return 'continuous';
  if (has('orders.poll')) return 'polled';
  if (has('orders.import')) return 'manual';
  return 'outbound-only';
}

/** True when the channel depends on a human moving files to stay current. */
export function isManualChannel(capabilities: readonly Capability[]): boolean {
  return syncModeOf(capabilities) === 'manual';
}

export function hasCapability(
  capabilities: readonly Capability[],
  capability: Capability,
): boolean {
  return capabilities.includes(capability);
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}
