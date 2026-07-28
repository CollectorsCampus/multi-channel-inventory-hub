import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import {
  applySale,
  computeAllListedQuantities,
  computePool,
  validateLedger,
  type AllocationView,
  type LedgerIssue,
  type LedgerView,
  type ListedQuantityChange,
  type SaleConflict,
} from './allocation';

/**
 * The single writer for every quantity in the system (TECHNICAL_DESIGN.md §4).
 *
 * Nothing else may write quantityOnHand, reserveQuantity, or a fixed
 * allocation's quantityAllocated. Concentrating it here is what makes the
 * allocation invariant enforceable at all, since it spans two tables and so
 * cannot be a database constraint (ADR 0001 §3).
 *
 * CONCURRENCY. Prisma interactive transactions take no row locks and SQLite has
 * none at all, so `SELECT ... FOR UPDATE` is not available and raw SQL is banned
 * in core (§3). Instead every mutation is a read-modify-write guarded by
 * InventoryItem.version: the update is conditional on the version we read, and a
 * zero-row result means someone else committed first, so we re-read and retry.
 * That is the portable equivalent of a row lock, and it is why two concurrent
 * sales cannot both claim the last unit.
 */

/**
 * Retry budget for the optimistic-locking loop.
 *
 * Sized for genuine contention rather than the happy path: a webhook burst can
 * land several sales for one SKU at once, and a bulk edit can touch the same
 * item repeatedly. Under N concurrent writers exactly one wins each round, so
 * the loser count falls by one per round — a handful of attempts is not enough
 * once N is more than a few.
 */
const MAX_ATTEMPTS = 12;

/** Base for the randomized backoff between attempts, in milliseconds. */
const RETRY_BASE_MS = 4;
const RETRY_CAP_MS = 250;

/**
 * Exponential backoff with full jitter.
 *
 * The jitter is the load-bearing part. Retrying immediately, or after a fixed
 * delay, makes contending writers collide again in lockstep — they livelock and
 * burn the whole budget without anyone making progress. Randomizing spreads
 * them out so each round has a clear winner.
 */
function retryDelayMs(attempt: number): number {
  return Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LedgerSnapshot {
  inventoryItemId: string;
  skuId: string;
  quantityOnHand: number;
  reserveQuantity: number;
  /** Units in no fixed partition and not reserved — what pooled channels draw on. */
  pool: number;
  version: number;
  allocations: Array<
    AllocationView & {
      /** What this channel should be advertising, derived from the current ledger. */
      desiredListedQuantity: number;
      /** What we believe it is actually advertising right now. */
      listedQuantity: number;
      status: string;
      price: number | null;
      currency: string;
      externalListingId: string | null;
    }
  >;
}

export interface MutationOutcome {
  ledger: LedgerSnapshot;
  /** Allocations whose advertised quantity moved and therefore need pushing. */
  changes: ListedQuantityChange[];
  /** Non-empty means a human needs to look. */
  conflicts: SaleConflict[];
}

/** What a caller wants an allocation to become. */
export interface AllocationWrite {
  channelInstanceId: string;
  mode: 'fixed' | 'pooled';
  quantityAllocated?: number | null;
  maxQuantity?: number | null;
  price?: number | null;
  currency?: string;
}

type ItemWithAllocations = Prisma.InventoryItemGetPayload<{ include: { allocations: true } }>;

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getLedger(inventoryItemId: string): Promise<LedgerSnapshot> {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      include: { allocations: true },
    });
    if (!item) throw new NotFoundException(`Inventory item ${inventoryItemId} not found.`);
    return toSnapshot(item);
  }

  /**
   * Validate a hypothetical ledger without writing anything.
   *
   * Backs the allocation editor's live validation (§7). The editor deliberately
   * does not reimplement the rules client-side — one authority for the maths,
   * even at the cost of a round trip per change.
   */
  async previewLedger(
    inventoryItemId: string,
    proposed: {
      quantityOnHand?: number;
      reserveQuantity?: number;
      allocations?: AllocationWrite[];
    },
  ): Promise<{ pool: number; issues: LedgerIssue[]; listed: Record<string, number> }> {
    const current = await this.getLedger(inventoryItemId);

    const allocations: AllocationView[] = proposed.allocations
      ? proposed.allocations.map((a, index) => normalizeWrite(a, `preview-${index}`))
      : current.allocations.map(stripToView);

    const ledger: LedgerView = {
      quantityOnHand: proposed.quantityOnHand ?? current.quantityOnHand,
      reserveQuantity: proposed.reserveQuantity ?? current.reserveQuantity,
      allocations,
    };

    return {
      pool: computePool(ledger),
      issues: validateLedger(ledger),
      listed: Object.fromEntries(computeAllListedQuantities(ledger)),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Change physical stock. `delta` is signed: +5 for intake, -1 for shrinkage.
   * Every call writes a StockMovement, so on-hand can always be reconstructed.
   */
  async adjustQuantityOnHand(
    inventoryItemId: string,
    delta: number,
    options: { reason: string; note?: string; actorUserId?: string },
  ): Promise<MutationOutcome> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException('Adjustment must be a non-zero whole number.');
    }

    return this.mutate(inventoryItemId, (ledger) => {
      const quantityOnHand = ledger.quantityOnHand + delta;
      if (quantityOnHand < 0) {
        throw new BadRequestException(
          `Cannot remove ${-delta}: only ${ledger.quantityOnHand} on hand.`,
        );
      }
      return {
        next: { ...ledger, quantityOnHand },
        movement: {
          delta,
          reason: options.reason,
          note: options.note,
          actorUserId: options.actorUserId,
        },
      };
    });
  }

  /** Set physical stock to an absolute figure (a stock count). */
  async setQuantityOnHand(
    inventoryItemId: string,
    quantityOnHand: number,
    options: { reason?: string; note?: string; actorUserId?: string } = {},
  ): Promise<MutationOutcome> {
    return this.mutate(inventoryItemId, (ledger) => {
      const delta = quantityOnHand - ledger.quantityOnHand;
      return {
        next: { ...ledger, quantityOnHand },
        movement:
          delta === 0
            ? undefined
            : {
                delta,
                reason: options.reason ?? 'adjustment',
                note: options.note,
                actorUserId: options.actorUserId,
              },
      };
    });
  }

  async setReserveQuantity(
    inventoryItemId: string,
    reserveQuantity: number,
  ): Promise<MutationOutcome> {
    return this.mutate(inventoryItemId, (ledger) => ({
      next: { ...ledger, reserveQuantity },
    }));
  }

  /**
   * Create or update one channel allocation.
   *
   * Rejected if the result would breach the invariant — the whole ledger is
   * validated, not just the row being touched, because raising one channel's
   * partition is exactly what steals stock from another.
   */
  async upsertAllocation(
    inventoryItemId: string,
    write: AllocationWrite,
  ): Promise<MutationOutcome> {
    return this.mutate(inventoryItemId, (ledger, current) => {
      const existing = current.allocations.find(
        (a) => a.channelInstanceId === write.channelInstanceId,
      );
      const id = existing?.id ?? `new:${write.channelInstanceId}`;
      const normalized = normalizeWrite(write, id);

      const allocations = existing
        ? ledger.allocations.map((a) => (a.id === existing.id ? normalized : a))
        : [...ledger.allocations, normalized];

      return {
        next: { ...ledger, allocations },
        allocationWrites: [{ ...write, id: existing?.id ?? null }],
      };
    });
  }

  async removeAllocation(
    inventoryItemId: string,
    channelInstanceId: string,
  ): Promise<MutationOutcome> {
    return this.mutate(inventoryItemId, (ledger, current) => {
      const existing = current.allocations.find((a) => a.channelInstanceId === channelInstanceId);
      if (!existing) {
        throw new NotFoundException(`No allocation for channel ${channelInstanceId}.`);
      }
      return {
        next: { ...ledger, allocations: ledger.allocations.filter((a) => a.id !== existing.id) },
        deleteAllocationIds: [existing.id],
      };
    });
  }

  /**
   * Record a sale that happened on a channel.
   *
   * The maths lives in {@link applySale}; this only persists the result. Unlike
   * the operator-facing mutations above it never rejects: a sale is a fact that
   * already happened, so conflicts are clamped, reported, and escalated rather
   * than refused (§6 step 4 — we never attempt automated cancellation).
   */
  async applySaleFromChannel(
    inventoryItemId: string,
    allocationId: string,
    quantity: number,
    options: { orderReference?: string } = {},
  ): Promise<MutationOutcome> {
    return this.mutate(inventoryItemId, (ledger) => {
      const result = applySale(ledger, allocationId, quantity);
      return {
        next: result.next,
        conflicts: result.conflicts,
        movement: {
          delta: result.next.quantityOnHand - ledger.quantityOnHand,
          reason: 'sale',
          note: options.orderReference,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // The read-modify-write engine
  // -------------------------------------------------------------------------

  private async mutate(
    inventoryItemId: string,
    plan: (
      ledger: LedgerView,
      current: ItemWithAllocations,
    ) => {
      next: LedgerView;
      conflicts?: SaleConflict[];
      movement?: { delta: number; reason: string; note?: string; actorUserId?: string };
      allocationWrites?: Array<AllocationWrite & { id: string | null }>;
      deleteAllocationIds?: string[];
    },
  ): Promise<MutationOutcome> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const current = await this.prisma.inventoryItem.findUnique({
        where: { id: inventoryItemId },
        include: { allocations: true },
      });
      if (!current) throw new NotFoundException(`Inventory item ${inventoryItemId} not found.`);

      const before = toLedgerView(current);
      const beforeListed = computeAllListedQuantities(before);
      const outcome = plan(before, current);
      const { next } = outcome;

      const issues = validateLedger(next);
      if (issues.length > 0) {
        throw new BadRequestException({
          message: 'This change would breach the allocation invariant.',
          issues,
        });
      }

      const committed = await this.prisma.$transaction(async (tx) => {
        // The guard. Conditional on the version we read, so a concurrent
        // writer's commit turns this into a no-op and we start over.
        const guard = await tx.inventoryItem.updateMany({
          where: { id: inventoryItemId, version: current.version },
          data: {
            quantityOnHand: next.quantityOnHand,
            reserveQuantity: next.reserveQuantity,
            version: { increment: 1 },
          },
        });
        if (guard.count === 0) return false;

        for (const id of outcome.deleteAllocationIds ?? []) {
          await tx.channelAllocation.delete({ where: { id } });
        }

        for (const write of outcome.allocationWrites ?? []) {
          const data = {
            mode: write.mode,
            quantityAllocated: write.mode === 'fixed' ? (write.quantityAllocated ?? 0) : null,
            maxQuantity: write.mode === 'pooled' ? (write.maxQuantity ?? null) : null,
            ...(write.price !== undefined ? { price: write.price } : {}),
            ...(write.currency !== undefined ? { currency: write.currency } : {}),
          };
          if (write.id) {
            await tx.channelAllocation.update({ where: { id: write.id }, data });
          } else {
            await tx.channelAllocation.create({
              data: { ...data, inventoryItemId, channelInstanceId: write.channelInstanceId },
            });
          }
        }

        // Persist recomputed quantities for allocations the plan did not rewrite.
        for (const allocation of next.allocations) {
          if (allocation.id.startsWith('new:')) continue;
          const existing = current.allocations.find((a) => a.id === allocation.id);
          if (!existing) continue;
          if (existing.quantityAllocated !== allocation.quantityAllocated) {
            await tx.channelAllocation.update({
              where: { id: allocation.id },
              data: { quantityAllocated: allocation.quantityAllocated },
            });
          }
        }

        if (outcome.movement) {
          await tx.stockMovement.create({
            data: {
              inventoryItemId,
              delta: outcome.movement.delta,
              resultingOnHand: next.quantityOnHand,
              reason: outcome.movement.reason,
              note: outcome.movement.note ?? null,
              actorUserId: outcome.movement.actorUserId ?? null,
            },
          });
        }

        return true;
      });

      if (!committed) {
        this.logger.debug(
          `Version conflict on ${inventoryItemId} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying.`,
        );
        await sleep(retryDelayMs(attempt));
        continue;
      }

      // Re-read once, after the commit. Allocations created by this mutation
      // only acquire their real ids here, so this is the first point at which
      // desired quantities can be keyed by something a caller can act on.
      const ledger = await this.getLedger(inventoryItemId);

      const changes: ListedQuantityChange[] = [];
      for (const allocation of ledger.allocations) {
        // Absent from `beforeListed` means newly created: it goes from
        // advertising nothing to advertising its derived quantity.
        const from = beforeListed.get(allocation.id) ?? 0;
        if (from !== allocation.desiredListedQuantity) {
          changes.push({
            allocationId: allocation.id,
            channelInstanceId: allocation.channelInstanceId,
            from,
            to: allocation.desiredListedQuantity,
          });
        }
      }

      // listedQuantity caches what we believe is live on each channel. With no
      // connectors yet there is nothing to push to, so deriving it here is
      // accurate. Phase 3 moves this write into the outbound worker, where it
      // may only happen after a push actually succeeds.
      await this.syncListedQuantityCache(ledger);
      for (const allocation of ledger.allocations) {
        allocation.listedQuantity = allocation.desiredListedQuantity;
      }

      return { ledger, changes, conflicts: outcome.conflicts ?? [] };
    }

    throw new ConflictException(
      `Inventory item ${inventoryItemId} is being modified concurrently; ` +
        `gave up after ${MAX_ATTEMPTS} attempts.`,
    );
  }

  private async syncListedQuantityCache(ledger: LedgerSnapshot): Promise<void> {
    const stale = ledger.allocations.filter((a) => a.listedQuantity !== a.desiredListedQuantity);
    await Promise.all(
      stale.map((a) =>
        this.prisma.channelAllocation.update({
          where: { id: a.id },
          data: { listedQuantity: a.desiredListedQuantity },
        }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toLedgerView(item: ItemWithAllocations): LedgerView {
  return {
    quantityOnHand: item.quantityOnHand,
    reserveQuantity: item.reserveQuantity,
    allocations: item.allocations.map((a) => ({
      id: a.id,
      channelInstanceId: a.channelInstanceId,
      mode: a.mode === 'fixed' ? 'fixed' : 'pooled',
      quantityAllocated: a.quantityAllocated,
      maxQuantity: a.maxQuantity,
    })),
  };
}

function toSnapshot(item: ItemWithAllocations): LedgerSnapshot {
  const view = toLedgerView(item);
  const listed = computeAllListedQuantities(view);

  return {
    inventoryItemId: item.id,
    skuId: item.skuId,
    quantityOnHand: item.quantityOnHand,
    reserveQuantity: item.reserveQuantity,
    pool: computePool(view),
    version: item.version,
    allocations: item.allocations.map((a) => ({
      id: a.id,
      channelInstanceId: a.channelInstanceId,
      mode: a.mode === 'fixed' ? 'fixed' : 'pooled',
      quantityAllocated: a.quantityAllocated,
      maxQuantity: a.maxQuantity,
      desiredListedQuantity: listed.get(a.id) ?? 0,
      listedQuantity: a.listedQuantity,
      status: a.status,
      price: a.price,
      currency: a.currency,
      externalListingId: a.externalListingId,
    })),
  };
}

function stripToView(a: LedgerSnapshot['allocations'][number]): AllocationView {
  return {
    id: a.id,
    channelInstanceId: a.channelInstanceId,
    mode: a.mode,
    quantityAllocated: a.quantityAllocated,
    maxQuantity: a.maxQuantity,
  };
}

/**
 * Force a write into its mode's shape before it reaches the maths.
 *
 * A `pooled` write carrying quantityAllocated (or vice versa) is rejected by
 * validateLedger, so silently dropping the irrelevant field here would turn a
 * caller's mistake into a silent no-op. Both are preserved so validation can
 * complain about them.
 */
function normalizeWrite(write: AllocationWrite, id: string): AllocationView {
  return {
    id,
    channelInstanceId: write.channelInstanceId,
    mode: write.mode,
    quantityAllocated: write.quantityAllocated ?? null,
    maxQuantity: write.maxQuantity ?? null,
  };
}
