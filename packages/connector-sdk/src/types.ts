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
