/**
 * Drift detection — TECHNICAL_DESIGN.md §6 "Reconciliation".
 *
 * Pure functions over plain values. No Prisma, no I/O, no clock — the same rule
 * `allocation.ts` follows, and for the same reason: what counts as drift is a
 * judgement worth testing exhaustively without a database in the way.
 *
 * ## What is being compared, and why it is not the obvious thing
 *
 * The comparison is `LiveListingState.quantity` against
 * **`allocation.listedQuantity`** — what we believe the channel is currently
 * advertising — and *not* against `desiredListedQuantity`, which is what the
 * ledger says it ought to advertise.
 *
 * That distinction is the whole design. `listedQuantity` is written only by the
 * outbound worker, only after a push succeeds, precisely so this function has
 * an honest record of our last confirmed state. Comparing against the desired
 * value instead would flag every allocation with a push still in flight, which
 * is normal, and would drown the genuine finding in noise.
 *
 * The reverse gap — desired and listed disagreeing because a push never landed
 * — is real and worth reporting, but it is not drift: the channel is doing
 * exactly what we last told it. It is reported separately as `pending`, and the
 * outbound worker has already raised a `sync_failure` alert for it.
 *
 * ## What is deliberately not drift
 *
 * - **Quantity 0 on both sides.** A listing priced but not stocked is a normal
 *   resting state, not a fault. 563 of 1333 rows in a real TCGPlayer export are
 *   quantity 0.
 * - **A listing the channel did not report.** Connectors are required to omit
 *   ids they cannot find rather than fabricating a zero, so an omission means
 *   "no answer", not "quantity 0". It is reported as `missing` — a distinct,
 *   quieter finding, because the commonest cause is a listing the seller
 *   removed on the platform, which is their prerogative.
 * - **Anything on a manual channel.** A file-based channel is only as current as
 *   the last human round trip, so its numbers are *expected* to lag. Such
 *   connectors do not declare `reconcile` at all, so they never reach here.
 */

/** The subset of a ChannelAllocation drift detection depends on. */
export interface ReconcilableAllocation {
  id: string;
  /**
   * The inventory item behind this allocation, carried onto each finding so the
   * operator can correct the ledger from the report — set the item's on-hand to
   * the channel's figure when the channel is the one that is right. Optional so
   * pure-function tests need not supply it; always populated in practice.
   */
  inventoryItemId?: string;
  externalListingId: string;
  /** What we believe the channel is advertising: written only after a successful push. */
  listedQuantity: number;
  /** What the ledger says it should advertise. */
  desiredListedQuantity: number;
  /** Cents, or null when the allocation has never been priced. */
  price: number | null;
  currency: string;
  status: string;
  /**
   * The product's name, set and condition, purely for display. Carried onto
   * every finding so the report can name what a listing is rather than showing
   * only its platform id — a `gid://…` tells an operator nothing. Optional so
   * the pure-function tests need not supply it; always populated in practice,
   * because a managed allocation always resolves to a catalog item.
   */
  name?: string;
  setName?: string;
  condition?: string;
}

/** The display identity carried onto a finding, so the UI can name the product. */
export interface ListingIdentity {
  /** Catalog item name, e.g. "Chaos Rising Booster Box". */
  name?: string;
  setName?: string;
  condition?: string;
}

/** What the platform says, as reported by the connector. */
export interface ObservedListing {
  externalListingId: string;
  quantity: number;
  /** Cents. Omitted when the platform does not report a price. */
  price?: number;
  currency?: string;
  active: boolean;
}

export type DriftKind =
  /** The channel advertises a different quantity than we last pushed. */
  | 'quantity'
  /** The channel shows a different price than we hold. */
  | 'price'
  /** The channel reports the listing as inactive while we believe it is live. */
  | 'inactive'
  /** The channel did not report this listing at all. */
  | 'missing';

export interface Drift extends ListingIdentity {
  allocationId: string;
  /** The item to correct when adopting the channel's figure. See ReconcilableAllocation. */
  inventoryItemId?: string;
  externalListingId: string;
  kind: DriftKind;
  /** Our value. Null for `missing`, where there is nothing to compare. */
  ours: number | null;
  /** The platform's value. Null for `missing`. */
  theirs: number | null;
  detail: string;
}

/** An allocation whose last push never landed. Not drift; see the header. */
export interface PendingPush extends ListingIdentity {
  allocationId: string;
  inventoryItemId?: string;
  externalListingId: string;
  listedQuantity: number;
  desiredListedQuantity: number;
}

export interface ReconcileReport {
  /** Allocations compared — those carrying an external listing id. */
  checked: number;
  drifts: Drift[];
  pending: PendingPush[];
  /** Listings the channel reported that map to no allocation we hold. */
  unmanaged: string[];
}

export interface DiffOptions {
  /**
   * Compare prices as well as quantities.
   *
   * Off by default. §6's conflict policy is last-write-wins on price, so a
   * price difference is not the same class of problem as a quantity one — and a
   * platform that rounds, applies its own fees, or reports a sale price would
   * otherwise generate a permanent stream of findings nobody can act on.
   */
  comparePrices?: boolean;
}

/**
 * Compare what a channel reports against what we believe it is showing.
 *
 * Deterministic and order-preserving: findings come back in allocation order so
 * two runs over unchanged data produce identical reports, which is what lets
 * the caller decide whether anything actually changed since last time.
 */
export function diffLiveState(
  allocations: readonly ReconcilableAllocation[],
  observed: readonly ObservedListing[],
  options: DiffOptions = {},
): ReconcileReport {
  const byId = new Map(observed.map((state) => [state.externalListingId, state]));
  const seen = new Set<string>();

  const drifts: Drift[] = [];
  const pending: PendingPush[] = [];

  for (const allocation of allocations) {
    // What each finding for this allocation carries beyond the drift itself:
    // the product's identity, so the report can name it, and the item id, so
    // the operator can correct the ledger from the report. Built with
    // conditional spread so an allocation supplying none of these adds no keys
    // — which keeps findings byte-identical to before for callers (and tests)
    // that do not supply them.
    const identity: ListingIdentity & { inventoryItemId?: string } = {};
    if (allocation.name) identity.name = allocation.name;
    if (allocation.setName) identity.setName = allocation.setName;
    if (allocation.condition) identity.condition = allocation.condition;
    if (allocation.inventoryItemId) identity.inventoryItemId = allocation.inventoryItemId;

    if (allocation.listedQuantity !== allocation.desiredListedQuantity) {
      pending.push({
        ...identity,
        allocationId: allocation.id,
        externalListingId: allocation.externalListingId,
        listedQuantity: allocation.listedQuantity,
        desiredListedQuantity: allocation.desiredListedQuantity,
      });
    }

    const live = byId.get(allocation.externalListingId);

    if (!live) {
      // Absent, not zero. A connector that cannot find an id must omit it, so
      // this means the platform gave no answer — most often a listing the
      // seller deleted on the platform, which is theirs to do.
      drifts.push({
        ...identity,
        allocationId: allocation.id,
        externalListingId: allocation.externalListingId,
        kind: 'missing',
        ours: null,
        theirs: null,
        detail: `The channel did not report listing ${allocation.externalListingId}. It may have been removed there.`,
      });
      continue;
    }

    seen.add(allocation.externalListingId);

    if (live.quantity !== allocation.listedQuantity) {
      drifts.push({
        ...identity,
        allocationId: allocation.id,
        externalListingId: allocation.externalListingId,
        kind: 'quantity',
        ours: allocation.listedQuantity,
        theirs: live.quantity,
        detail: `The channel shows ${live.quantity}; we last pushed ${allocation.listedQuantity}.`,
      });
    }

    // Only meaningful when we believe the listing is live. A delisted
    // allocation reported inactive is agreement, not drift.
    if (!live.active && allocation.status !== 'delisted') {
      drifts.push({
        ...identity,
        allocationId: allocation.id,
        externalListingId: allocation.externalListingId,
        kind: 'inactive',
        ours: allocation.listedQuantity,
        theirs: live.quantity,
        detail: `The channel reports this listing as inactive, but we believe it is live.`,
      });
    }

    if (
      options.comparePrices &&
      live.price !== undefined &&
      allocation.price !== null &&
      live.price !== allocation.price
    ) {
      drifts.push({
        ...identity,
        allocationId: allocation.id,
        externalListingId: allocation.externalListingId,
        kind: 'price',
        ours: allocation.price,
        theirs: live.price,
        detail: `The channel prices this at ${formatCents(live.price)}; we hold ${formatCents(allocation.price)}.`,
      });
    }
  }

  // Listings the platform reported that we do not manage. Not a fault — sellers
  // list things outside the hub — but worth surfacing, because it is the only
  // signal that the two sides disagree about what exists.
  const unmanaged = observed.map((state) => state.externalListingId).filter((id) => !seen.has(id));

  return { checked: allocations.length, drifts, pending, unmanaged };
}

/**
 * The drifts auto-correction is allowed to act on.
 *
 * §6 permits correction in exactly one direction — push our ledger to the
 * channel — and never the other way. So only a quantity difference qualifies:
 * we know what the channel should advertise and can say so again.
 *
 * `missing` is excluded because the listing may not exist to push to, and
 * `inactive` because reactivating a listing the seller deliberately pulled
 * would be the software overruling them. `price` is excluded because §6's price
 * policy is last-write-wins, so the channel's value may legitimately be newer
 * than ours.
 */
export function correctableDrifts(drifts: readonly Drift[]): Drift[] {
  return drifts.filter((drift) => drift.kind === 'quantity');
}

/** One line an operator can read without opening the payload. */
export function summarize(report: ReconcileReport): string {
  if (report.drifts.length === 0) {
    return `Checked ${report.checked} listing(s); everything matches.`;
  }

  const counts = new Map<DriftKind, number>();
  for (const drift of report.drifts) {
    counts.set(drift.kind, (counts.get(drift.kind) ?? 0) + 1);
  }

  const parts = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`);
  return `Checked ${report.checked} listing(s); ${report.drifts.length} differ (${parts.join(', ')}).`;
}

/** Cents to a decimal string, without touching a float. */
function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
