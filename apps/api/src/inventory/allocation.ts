/**
 * The allocation engine — TECHNICAL_DESIGN.md §4.
 *
 * Pure functions over plain values. No Prisma, no I/O, no clock. Everything
 * that decides *how many units a channel may list* lives here and nowhere else,
 * so the rules can be exhaustively tested without a database and so connectors
 * never have a reason to compute a quantity themselves.
 *
 * The two modes:
 *
 *   fixed   the channel owns an exclusive partition. It lists exactly its
 *           partition, and a sale there consumes only that partition.
 *
 *   pooled  the channel mirrors the shared remainder, optionally capped:
 *
 *             pool         = quantityOnHand − Σ(fixed partitions) − reserveQuantity
 *             listed(chan) = min(chan.maxQuantity ?? ∞, pool)
 *
 *           Pooled mode deliberately exposes the same physical units on several
 *           channels at once, so two channels can each believe they hold the
 *           last copy. That race is inherent to the mode, not a defect; it is
 *           handled pessimistically here and escalated to a human.
 */

export type AllocationMode = 'fixed' | 'pooled';

/** The subset of a ChannelAllocation the quantity math actually depends on. */
export interface AllocationView {
  id: string;
  channelInstanceId: string;
  mode: AllocationMode;
  /** fixed mode only: the exclusive partition size. */
  quantityAllocated: number | null;
  /** pooled mode only: optional cap. null means "mirror the whole pool". */
  maxQuantity: number | null;
}

/** The subset of an InventoryItem plus its allocations. */
export interface LedgerView {
  quantityOnHand: number;
  reserveQuantity: number;
  allocations: AllocationView[];
}

export const UNCAPPED = null;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Total units committed to exclusive partitions.
 *
 * A `fixed` allocation with a null partition counts as 0 rather than throwing:
 * this function is called on the validation path, and validation must be able
 * to report *all* problems rather than dying on the first malformed row.
 */
export function sumFixedPartitions(allocations: readonly AllocationView[]): number {
  return allocations.reduce(
    (total, a) => (a.mode === 'fixed' ? total + (a.quantityAllocated ?? 0) : total),
    0,
  );
}

/**
 * Units available to pooled channels.
 *
 * Clamped at zero. A negative pool means the ledger is already inconsistent
 * (see {@link validateLedger}); pooled channels must list nothing in that
 * state rather than propagating a negative downstream.
 */
export function computePool(ledger: LedgerView): number {
  const raw =
    ledger.quantityOnHand - sumFixedPartitions(ledger.allocations) - ledger.reserveQuantity;
  return Math.max(0, raw);
}

/** Units in neither a fixed partition nor the reserve — the pool, by definition. */
export function unallocatedQuantity(ledger: LedgerView): number {
  return computePool(ledger);
}

/** How many units this channel should be advertising right now. */
export function computeListedQuantity(allocation: AllocationView, pool: number): number {
  if (allocation.mode === 'fixed') {
    return Math.max(0, allocation.quantityAllocated ?? 0);
  }
  const cap = allocation.maxQuantity ?? Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(cap, pool));
}

/** Desired listed quantity for every allocation, keyed by allocation id. */
export function computeAllListedQuantities(ledger: LedgerView): Map<string, number> {
  const pool = computePool(ledger);
  return new Map(ledger.allocations.map((a) => [a.id, computeListedQuantity(a, pool)]));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type LedgerIssueCode =
  | 'negative_on_hand'
  | 'negative_reserve'
  | 'fixed_missing_quantity'
  | 'fixed_negative_quantity'
  | 'pooled_negative_max'
  | 'pooled_has_partition'
  | 'fixed_has_max_quantity'
  | 'non_integer_quantity'
  | 'over_allocated';

export interface LedgerIssue {
  code: LedgerIssueCode;
  message: string;
  /** Present when the issue belongs to one specific allocation. */
  allocationId?: string;
}

/**
 * Every rule the ledger must satisfy, checked together.
 *
 * Returns all violations rather than the first, because this drives the
 * allocation editor's live validation (§7) — an operator adjusting several
 * channels wants to see every problem at once, not fix them one round-trip at
 * a time.
 *
 * The headline rule is the last one:
 *
 *   quantityOnHand ≥ Σ(fixed quantityAllocated) + reserveQuantity ≥ 0
 *
 * It spans two tables, so no CHECK constraint can express it (ADR 0001 §3).
 * This function is the enforcement point, and InventoryService must call it
 * inside the same transaction as any write it guards.
 */
export function validateLedger(ledger: LedgerView): LedgerIssue[] {
  const issues: LedgerIssue[] = [];

  if (!Number.isInteger(ledger.quantityOnHand)) {
    issues.push({
      code: 'non_integer_quantity',
      message: 'quantityOnHand must be a whole number.',
    });
  }
  if (!Number.isInteger(ledger.reserveQuantity)) {
    issues.push({
      code: 'non_integer_quantity',
      message: 'reserveQuantity must be a whole number.',
    });
  }
  if (ledger.quantityOnHand < 0) {
    issues.push({
      code: 'negative_on_hand',
      message: `quantityOnHand cannot be negative (got ${ledger.quantityOnHand}).`,
    });
  }
  if (ledger.reserveQuantity < 0) {
    issues.push({
      code: 'negative_reserve',
      message: `reserveQuantity cannot be negative (got ${ledger.reserveQuantity}).`,
    });
  }

  for (const allocation of ledger.allocations) {
    if (allocation.mode === 'fixed') {
      if (allocation.quantityAllocated === null) {
        issues.push({
          code: 'fixed_missing_quantity',
          allocationId: allocation.id,
          message: 'A fixed allocation must declare quantityAllocated.',
        });
      } else if (!Number.isInteger(allocation.quantityAllocated)) {
        issues.push({
          code: 'non_integer_quantity',
          allocationId: allocation.id,
          message: 'quantityAllocated must be a whole number.',
        });
      } else if (allocation.quantityAllocated < 0) {
        issues.push({
          code: 'fixed_negative_quantity',
          allocationId: allocation.id,
          message: `quantityAllocated cannot be negative (got ${allocation.quantityAllocated}).`,
        });
      }

      // Not merely unused — a cap on a fixed allocation reads as though it
      // limits the partition, which it does not. Reject it rather than let it
      // sit in the row implying behaviour that never happens.
      if (allocation.maxQuantity !== null) {
        issues.push({
          code: 'fixed_has_max_quantity',
          allocationId: allocation.id,
          message: 'maxQuantity applies to pooled allocations only.',
        });
      }
    } else {
      if (allocation.maxQuantity !== null) {
        if (!Number.isInteger(allocation.maxQuantity)) {
          issues.push({
            code: 'non_integer_quantity',
            allocationId: allocation.id,
            message: 'maxQuantity must be a whole number.',
          });
        } else if (allocation.maxQuantity < 0) {
          issues.push({
            code: 'pooled_negative_max',
            allocationId: allocation.id,
            message: `maxQuantity cannot be negative (got ${allocation.maxQuantity}).`,
          });
        }
      }

      if (allocation.quantityAllocated !== null) {
        issues.push({
          code: 'pooled_has_partition',
          allocationId: allocation.id,
          message: 'quantityAllocated applies to fixed allocations only.',
        });
      }
    }
  }

  const committed = sumFixedPartitions(ledger.allocations) + ledger.reserveQuantity;
  if (committed > ledger.quantityOnHand) {
    issues.push({
      code: 'over_allocated',
      message:
        `Fixed allocations (${sumFixedPartitions(ledger.allocations)}) plus reserve ` +
        `(${ledger.reserveQuantity}) total ${committed}, which exceeds the ` +
        `${ledger.quantityOnHand} on hand.`,
    });
  }

  return issues;
}

export function isLedgerValid(ledger: LedgerView): boolean {
  return validateLedger(ledger).length === 0;
}

// ---------------------------------------------------------------------------
// Applying a sale
// ---------------------------------------------------------------------------

export type SaleConflictCode =
  'oversell_on_hand' | 'oversell_partition' | 'reserve_reduced' | 'partition_reduced';

export interface SaleConflict {
  code: SaleConflictCode;
  message: string;
  allocationId?: string;
  /** Units that could not be honoured, or units reclaimed to restore the invariant. */
  shortfall: number;
}

export interface ListedQuantityChange {
  allocationId: string;
  channelInstanceId: string;
  from: number;
  to: number;
}

export interface SaleResult {
  /** The ledger after the sale. Always satisfies the invariant. */
  next: LedgerView;
  /** Allocations whose advertised quantity moved, and therefore need pushing. */
  changes: ListedQuantityChange[];
  /** Anything a human needs to know about. Non-empty means raise an alert. */
  conflicts: SaleConflict[];
}

/**
 * Apply a sale of `quantity` units against `allocationId`.
 *
 * Sale semantics differ by the *selling* allocation's mode (§4):
 *   - fixed:  decrements that partition and on-hand. Pooled channels then shrink
 *             because the pool shrank; other fixed partitions are untouched.
 *   - pooled: decrements on-hand only, then every pooled channel recomputes.
 *
 * Three things can go wrong, and all of them resolve pessimistically — the
 * lower quantity always wins, and a human is always told:
 *
 *  1. on-hand would go negative. We sold something we did not have. Clamp to
 *     zero and report; §6 is explicit that we never attempt auto-cancellation.
 *
 *  2. a fixed partition would go negative. Same treatment, scoped to the channel.
 *
 *  3. **The invariant breaks even though nothing went negative.** This is the
 *     case the design document does not cover. A pooled sale reduces on-hand
 *     without touching any partition, so on-hand can fall below
 *     Σ(fixed) + reserve while every individual number is still ≥ 0. Example:
 *     10 on hand, TCGPlayer fixed at 6, Shopify pooled uncapped lists 4; four
 *     pooled sales land, then a fifth arrives from a stale listing. On-hand is
 *     now 5 but TCGPlayer is still advertising 6 units that do not exist.
 *
 *     Leaving that alone would guarantee a future oversell, so the invariant is
 *     restored here: reserve is consumed first (absorbing shortfall is what a
 *     reserve is *for*), then the largest fixed partitions are trimmed. Every
 *     reduction is reported as a conflict so the operator learns that a
 *     channel's committed stock was taken away.
 */
export function applySale(ledger: LedgerView, allocationId: string, quantity: number): SaleResult {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Sale quantity must be a positive whole number (got ${quantity}).`);
  }

  const selling = ledger.allocations.find((a) => a.id === allocationId);
  if (!selling) {
    throw new Error(`No allocation ${allocationId} on this inventory item.`);
  }

  const before = computeAllListedQuantities(ledger);
  const conflicts: SaleConflict[] = [];

  const rawOnHand = ledger.quantityOnHand - quantity;
  let quantityOnHand = rawOnHand;
  if (rawOnHand < 0) {
    quantityOnHand = 0;
    conflicts.push({
      code: 'oversell_on_hand',
      shortfall: -rawOnHand,
      message:
        `Sold ${quantity} but only ${ledger.quantityOnHand} were on hand. ` +
        `Clamped to zero; ${-rawOnHand} unit(s) oversold.`,
    });
  }

  // Copied per-allocation so the caller's ledger is never mutated; the copies
  // are then edited in place while restoring the invariant.
  const allocations = ledger.allocations.map((a) => ({ ...a }));

  if (selling.mode === 'fixed') {
    const target = allocations.find((a) => a.id === allocationId)!;
    const heldBefore = target.quantityAllocated ?? 0;
    const rawPartition = heldBefore - quantity;
    if (rawPartition < 0) {
      target.quantityAllocated = 0;
      conflicts.push({
        code: 'oversell_partition',
        allocationId,
        shortfall: -rawPartition,
        message:
          `Channel sold ${quantity} but its partition held ${heldBefore}. ` +
          `Clamped to zero; ${-rawPartition} unit(s) oversold.`,
      });
    } else {
      target.quantityAllocated = rawPartition;
    }
  }

  let reserveQuantity = ledger.reserveQuantity;

  // Restore the invariant if the sale broke it (case 3 above).
  let excess = sumFixedPartitions(allocations) + reserveQuantity - quantityOnHand;

  if (excess > 0 && reserveQuantity > 0) {
    const taken = Math.min(excess, reserveQuantity);
    reserveQuantity -= taken;
    excess -= taken;
    conflicts.push({
      code: 'reserve_reduced',
      shortfall: taken,
      message:
        `Reserve reduced by ${taken} to keep committed stock within the ${quantityOnHand} ` +
        `on hand.`,
    });
  }

  while (excess > 0) {
    // Largest partition first: predictable, and it takes from whichever channel
    // is holding the most rather than emptying a small one entirely.
    const largest = allocations
      .filter((a) => a.mode === 'fixed' && (a.quantityAllocated ?? 0) > 0)
      .sort((a, b) => (b.quantityAllocated ?? 0) - (a.quantityAllocated ?? 0))[0];

    // Nothing left to reclaim. Only reachable if on-hand was clamped to zero,
    // in which case the oversell conflict above already covers it.
    if (!largest) break;

    const taken = Math.min(excess, largest.quantityAllocated ?? 0);
    largest.quantityAllocated = (largest.quantityAllocated ?? 0) - taken;
    excess -= taken;
    conflicts.push({
      code: 'partition_reduced',
      allocationId: largest.id,
      shortfall: taken,
      message:
        `Fixed partition reduced by ${taken}: a pooled sale left fewer units on hand ` +
        `than the channel had committed.`,
    });
  }

  const next: LedgerView = { quantityOnHand, reserveQuantity, allocations };

  const after = computeAllListedQuantities(next);
  const changes: ListedQuantityChange[] = [];
  for (const allocation of next.allocations) {
    const from = before.get(allocation.id) ?? 0;
    const to = after.get(allocation.id) ?? 0;
    if (from !== to) {
      changes.push({
        allocationId: allocation.id,
        channelInstanceId: allocation.channelInstanceId,
        from,
        to,
      });
    }
  }

  return { next, changes, conflicts };
}
