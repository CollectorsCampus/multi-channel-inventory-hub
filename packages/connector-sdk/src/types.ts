/**
 * The values that cross the connector boundary.
 *
 * Two rules shape everything here:
 *
 *  1. **Money is integer cents.** Never a float, never a formatted string. A
 *     rounding error in a price is a real financial defect.
 *  2. **Connectors never compute quantities.** Requests carry the quantity the
 *     core has already decided on. A connector that derives one has broken the
 *     abstraction the whole design rests on.
 */

/** Per-call context. Credentials live here and nowhere else. */
export interface Ctx {
  /** Which configured channel this call is for. */
  channelInstanceId: string;

  /** Parsed, non-secret connector config, shaped by the connector's configSchema. */
  config: Record<string, unknown>;

  /**
   * Decrypted secrets, supplied by the core's credential store at call time.
   *
   * Never persist these, never log them, and never write them back into
   * `config` — the core encrypts them at rest precisely so they exist in
   * memory only for the duration of a call.
   */
  secrets: Readonly<Record<string, string>>;

  /** Scoped logger. Anything written here may end up in an operator's console. */
  logger: ConnectorLogger;

  /** Cancellation, driven by the queue's job timeout. Long calls should honour it. */
  signal?: AbortSignal;
}

export interface ConnectorLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// Catalog types live in catalog.ts, behind the separate CatalogSource
// interface — product lookup is not a sales-channel concern.

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/** Identifies which of our allocations a call concerns. */
export interface ListingRef {
  allocationId: string;
  /** Null before the listing exists on the platform. */
  externalListingId: string | null;
}

export interface PushListingRequest extends ListingRef {
  sku: SkuDescriptor;
  /** Decided by the core. Do not recompute. */
  quantity: number;
  /** Cents. */
  price: number;
  currency: string;
}

export interface PushListingResult {
  /** The platform's id for the listing, persisted so later calls can address it. */
  externalListingId: string;
}

export interface UpdateQuantityRequest extends ListingRef {
  /** Decided by the core. Do not recompute. */
  quantity: number;
}

export interface UpdatePriceRequest extends ListingRef {
  /** Cents. */
  price: number;
  currency: string;
}

export type DelistRequest = ListingRef;

/**
 * Stamp our identifier onto the channel's seller-SKU field.
 *
 * `sku` is opaque to the connector: the core decides what identity to record —
 * today a TCGPlayer product id, so a rebuilt hub can re-derive its links from
 * the storefront rather than from a backup.
 *
 * Connectors must write it verbatim. Normalising it, prefixing it or truncating
 * it would break the equality the matcher depends on, and a match that is
 * `certain` today would silently degrade to a name guess tomorrow.
 */
export interface UpdateListingSkuRequest {
  externalListingId: string;
  sku: string;
}

/**
 * Bring a listing into existence on a platform that does not have it.
 *
 * Everything a platform needs to render a product is an **input**, not
 * something the connector invents. That is the answer to the objection
 * `pushListing` raises against creating — that a product carries titles,
 * images and publication state the hub has no opinion about. The hub still has
 * no opinion; the operator supplies one.
 *
 * ## Grouping, and why the core does not send a product id
 *
 * A card is one product with a variant per condition, so creating the Lightly
 * Played copy of a card whose Near Mint copy already exists must *add a
 * variant*, not make a second product. The core knows variant ids — that is
 * what `ChannelAllocation.externalListingId` holds — and nothing else, so it
 * names a **sibling variant** it already drives and lets the connector resolve
 * whatever the platform calls the thing above it. Sending a product id would
 * mean the core storing one, which is a schema change to express something it
 * can already point at.
 */
export interface CreateListingRequest {
  /**
   * Seller SKU for the new variant, and the idempotency key.
   *
   * A connector must look this up before creating: finding it means the
   * listing already exists and its id is returned unchanged. Creating a second
   * product for a card an operator already listed is the failure this prevents,
   * and on a storefront it is visible to customers.
   */
  sku: string;
  title: string;
  description?: string;
  imageUrl?: string;
  /** Publisher or brand, where the platform models one. */
  vendor?: string;
  /** Applied verbatim. The core never derives these; see CreateListingResult. */
  tags?: readonly string[];
  /** What distinguishes variants of this product, e.g. "Condition". */
  optionName?: string;
  /** This variant's value for that option, e.g. "Near Mint". */
  optionValue?: string;
  /** Cents. Omitted leaves the platform's default, which is usually zero. */
  price?: number;
  /**
   * A variant this hub already drives belonging to the same product.
   *
   * Present means "add a variant to whatever product this belongs to"; absent
   * means "create a new product". The core decides which, because deciding that
   * two SKUs are the same card is a catalogue judgement (rule 6).
   */
  siblingListingId?: string;
}

export interface CreateListingResult {
  /** The platform's id for the new listing, in the same space as everything else. */
  externalListingId: string;
  /** False when a variant was added to an existing product, or nothing was created. */
  createdProduct: boolean;
  /**
   * True when the SKU already existed and its listing was returned untouched.
   *
   * Distinct from `createdProduct: false`, which also covers adding a variant.
   * The core reports it so an operator re-running a selection sees "already
   * there" rather than a count that suggests work happened.
   */
  alreadyExisted: boolean;
}

/** Enough of a SKU for a connector to describe it to a platform. */
export interface SkuDescriptor {
  skuId: string;
  name: string;
  condition: string;
  printing: string;
  language: string;
  game?: string;
  setName?: string;
  /** Platform product ids we already know, keyed by source. */
  externalRefs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * A platform event, normalized.
 *
 * Deliberately narrow. A connector's job is to translate, not to interpret —
 * anything requiring a decision belongs in the core, where the allocation rules
 * live.
 */
export type NormalizedEvent = SaleEvent | ListingRemovedEvent;

export interface SaleEvent {
  type: 'sale';
  /** Platform listing id, which the core maps back to an allocation. */
  externalListingId: string;
  quantity: number;
  /** Platform order reference, recorded on the stock movement. */
  orderReference?: string;
  occurredAt?: Date;
  /**
   * Idempotency key. The core dedupes on it, so a replayed webhook or a
   * re-uploaded export cannot decrement stock twice. Connectors must derive it
   * deterministically — a hash of the payload is fine when the platform gives
   * no id of its own.
   */
  externalEventId: string;
}

export interface ListingRemovedEvent {
  type: 'listing_removed';
  externalListingId: string;
  externalEventId: string;
  occurredAt?: Date;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** What the platform believes about a listing, for drift detection (§6). */
export interface LiveListingState {
  externalListingId: string;
  quantity: number;
  /** Cents. Omitted when the platform does not report it. */
  price?: number;
  currency?: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * A listing that already exists on the channel, for matching against inventory.
 *
 * Everything but the id is optional and *must* be treated as such. These fields
 * are evidence offered to a matcher, not a schema: platforms differ in which of
 * them they populate, and a seller can leave any of them blank. A matcher that
 * assumes `sku` is present will simply stop proposing anything on a store that
 * does not use it.
 */
export interface ChannelListing {
  /**
   * The channel's own id for this listing.
   *
   * **Must be byte-identical to what the connector's other methods use as
   * `externalListingId`.** A confirmed match writes this straight onto an
   * allocation, so an id in a different shape here than `pushListing` and
   * `updateQuantity` expect produces a link that points at nothing and fails on
   * the first sale rather than at confirmation time.
   */
  externalListingId: string;

  /** What a human would recognise it by. Usually product plus variant. */
  title: string;

  /** The seller's own code, where the platform has such a field. */
  sku?: string;
  /** UPC/EAN/GTIN. Present on some sealed product and almost no singles. */
  barcode?: string;

  /** Cents, never a float. Omitted when the platform does not report it. */
  price?: number;
  currency?: string;
  /** The channel's advertised quantity, where it reports one. */
  quantity?: number;
  active?: boolean;
}

/** One page of {@link ChannelListing}s. */
export interface ChannelListingPage {
  listings: ChannelListing[];
  /**
   * Opaque cursor for the next page, absent on the last.
   *
   * Opaque on purpose: the core stores and returns it without interpretation,
   * so a platform can change from a page number to a keyset cursor without the
   * core caring.
   */
  nextCursor?: string;
}

export interface EnumerateListingsRequest {
  /** Absent on the first page; otherwise a cursor a previous page returned. */
  cursor?: string;
  /** A hint, not a contract — a platform may return fewer or cap it lower. */
  limit?: number;

  /**
   * Free text to narrow the page to, where the platform can.
   *
   * **Best-effort by design.** A connector whose platform has no search passes it
   * over and returns everything; the core must therefore treat the result as
   * unfiltered and never assume a returned listing matches. Filtering here is an
   * efficiency, not a correctness boundary.
   *
   * It earns its place because matching is scoped to one set while a page of a
   * real storefront is not: enumerating 100 variants of a Pokémon shop to match
   * one set produced 2 matches and 98 rows of noise, and the noise is what stops
   * a review screen being read.
   */
  search?: string;
}

// ---------------------------------------------------------------------------
// File transport (ADR 0002)
// ---------------------------------------------------------------------------

/** A file the operator downloads and uploads to the platform themselves. */
export interface ExportedFile {
  filename: string;
  contentType: string;
  /** Bytes, not a string — encodings and BOMs matter to the platforms consuming these. */
  content: Buffer;
}

/** A file the operator exported from the platform and uploaded to us. */
export interface ImportedFile {
  filename: string;
  content: Buffer;
}

export interface ExportListingsRequest {
  listings: Array<
    ListingRef & {
      sku: SkuDescriptor;
      /** What the core has decided this channel should be advertising. */
      quantity: number;
      /**
       * What we believe it is advertising now, written only after a successful
       * push.
       *
       * Carried alongside `quantity` because some platforms accept only a
       * *change* rather than an absolute value — TCGPlayer's CSV import has no
       * way to express "set this to 4" — so a connector may need both to say
       * anything truthful, or to decide it cannot.
       */
      listedQuantity: number;
      price: number | null;
      currency: string;
    }
  >;
}

/**
 * Outcome of parsing an operator-supplied file.
 *
 * Rows that cannot be parsed are reported rather than thrown, because a single
 * malformed line in a thousand-row export must not discard the other 999. The
 * core surfaces `problems` to the operator and processes what it got.
 */
export interface ImportResult<T> {
  records: T[];
  problems: ImportProblem[];
}

export interface ImportProblem {
  /** 1-based line number where known. */
  line?: number;
  message: string;
}
