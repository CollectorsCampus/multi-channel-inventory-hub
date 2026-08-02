import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { OutboundQueue } from '../queue/outbound-queue.service';
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

  /**
   * The channel's own id for the listing this allocation drives.
   *
   * Writable here because it had to be, and nothing else could. The outbound
   * worker sets it from `pushListing`'s result — but Shopify's `pushListing`
   * refuses to run without it ("Create the product in Shopify, then set the
   * variant id on this allocation"), so for an operator with an existing store
   * the field could never be populated and every push failed forever. A closed
   * loop, and the reason the match workflow exists.
   *
   * `undefined` leaves it alone; `null` clears it, which is how an operator
   * detaches a link without deleting the allocation and its quantities.
   */
  externalListingId?: string | null;
}

type ItemWithAllocations = Prisma.InventoryItemGetPayload<{ include: { allocations: true } }>;

export interface InventoryQuery {
  search?: string;
  game?: string;
  condition?: string;
  channelInstanceId?: string;
  /** Items whose catalog item has no game — non-TCG goods, hand-entered rows. */
  noGame?: boolean;
  /** Items on no channel at all. Mutually sensible with `channelInstanceId`, not with it. */
  unlisted?: boolean;
  hasUnallocated?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'quantityOnHand' | 'updatedAt' | 'condition';
  sortDir?: 'asc' | 'desc';
}

export type InventoryRow = LedgerSnapshot & {
  name: string;
  game: string | null;
  setName: string | null;
  imageUrl: string | null;
  condition: string;
  printing: string;
  language: string;
};

export interface InventoryPage {
  items: InventoryRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * One channel's view of one allocation.
 *
 * Serves two readers with different needs, which is why it carries both
 * quantities:
 *
 * - **`quantity`** is the *desired* listed quantity — what the ledger says this
 *   channel should be advertising. This is what a file export emits; exporting
 *   the other one would push our own stale guess back at the channel.
 * - **`listedQuantity`** is what we believe it is advertising right now, written
 *   only after a successful push. This is what reconciliation compares against,
 *   because it is the only honest record of our last confirmed state.
 */
export interface ChannelListing {
  allocationId: string;
  externalListingId: string | null;
  quantity: number;
  listedQuantity: number;
  status: string;
  price: number | null;
  currency: string;
  sku: {
    skuId: string;
    name: string;
    condition: string;
    printing: string;
    language: string;
    game?: string;
    setName?: string;
  };
}

export interface CreateInventoryInput {
  name: string;
  game?: string;
  setName?: string;
  condition: string;
  printing?: string;
  language?: string;
  quantityOnHand?: number;
  costBasis?: number;
  externalSource?: string;
  externalId?: string;
  actorUserId?: string;
}

/** Sort keys are whitelisted by the DTO, so this only has to map them. */
function buildOrderBy(
  sortBy: NonNullable<InventoryQuery['sortBy']>,
  sortDir: 'asc' | 'desc',
): Prisma.InventoryItemOrderByWithRelationInput {
  switch (sortBy) {
    case 'name':
      return { sku: { catalogItem: { name: sortDir } } };
    case 'condition':
      return { sku: { condition: sortDir } };
    case 'quantityOnHand':
      return { quantityOnHand: sortDir };
    case 'updatedAt':
      return { updatedAt: sortDir };
  }
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  /**
   * `outbound` is optional so the service stays constructible without a queue.
   * The allocation unit tests instantiate it directly against a database and
   * have no Redis; making the dependency required would force every one of them
   * to stand one up to test maths that has nothing to do with queues.
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly outbound?: OutboundQueue,
  ) {}

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
   *
   * `listed` and any issue's `allocationId` are keyed by **channelInstanceId**,
   * not allocation id. A proposed allocation may not exist yet and so has no id
   * of its own; keying on something the caller already knows is the only way
   * the response can be matched back to the row being edited.
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
      ? proposed.allocations.map((a) => normalizeWrite(a, a.channelInstanceId))
      : current.allocations.map((a) => ({ ...stripToView(a), id: a.channelInstanceId }));

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

  /**
   * Server-side paginated, filtered and sorted inventory browse (§7).
   *
   * Free-text search runs against CatalogItem.searchName, a lower-cased copy
   * maintained on write, rather than Prisma's `mode: "insensitive"` — that
   * filter is PostgreSQL-only and would not compile for SQLite.
   */
  async listInventory(query: InventoryQuery): Promise<InventoryPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const where: Prisma.InventoryItemWhereInput = {
      sku: {
        ...(query.condition ? { condition: query.condition } : {}),
        catalogItem: {
          ...(query.search ? { searchName: { contains: query.search.trim().toLowerCase() } } : {}),
          ...(query.game ? { game: query.game } : {}),
          // A real bucket, not an absent filter: non-TCG goods and
          // hand-entered items carry no game, and "show me those" is a
          // question the browser must be able to ask.
          ...(query.noGame ? { game: null } : {}),
        },
      },
      ...(query.channelInstanceId
        ? { allocations: { some: { channelInstanceId: query.channelInstanceId } } }
        : {}),
      // "On no channel at all" — the question behind "what have I not listed
      // yet", which is the whole input to the creation screen. Unlike
      // `hasUnallocated` below this one *is* expressible in SQL, so it narrows
      // the result set rather than the current page.
      ...(query.unlisted ? { allocations: { none: {} } } : {}),
    };

    const orderBy = buildOrderBy(query.sortBy ?? 'name', query.sortDir ?? 'asc');

    const [total, rows] = await Promise.all([
      this.prisma.inventoryItem.count({ where }),
      this.prisma.inventoryItem.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { allocations: true, sku: { include: { catalogItem: true } } },
      }),
    ]);

    let items = rows.map((row) => ({
      ...toSnapshot(row),
      name: row.sku.catalogItem.name,
      game: row.sku.catalogItem.game,
      setName: row.sku.catalogItem.setName,
      // Already loaded with the catalog item, so carrying it costs nothing
      // here. Whether a browser fetches a hundred thumbnails is the browser's
      // decision, not this endpoint's.
      imageUrl: row.sku.catalogItem.imageUrl,
      condition: row.sku.condition,
      printing: row.sku.printing,
      language: row.sku.language,
    }));

    // `pool` is derived rather than stored, so it cannot be filtered in SQL
    // without duplicating the allocation maths in a query. Applied after the
    // page is fetched, which means the filter narrows the current page rather
    // than the result set — acceptable while it is a coarse toggle, but it
    // must move into the query if it ever becomes a primary browse axis.
    if (query.hasUnallocated) {
      items = items.filter((item) => item.pool > 0);
    }

    return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
  }

  /**
   * Games present in the ledger, with how many items each has.
   *
   * Derived from what is held rather than from what the catalog sources
   * declare, which is the difference between a filter that always works and
   * one that can offer a game returning nothing. Scryfall declares Magic and
   * tcgcsv declares nothing at all, so the declared list is no guide to what
   * an operator actually owns.
   *
   * A null game is reported rather than dropped: it is what non-TCG goods and
   * hand-entered items have, and hiding the bucket would hide the stock.
   */
  async listGames(): Promise<Array<{ game: string | null; items: number }>> {
    // Which games exist. `groupBy` here counts *catalog items*, which is not
    // the number the filter will produce — one card with three conditions is
    // one catalog item and three inventory rows — so it is used only for the
    // distinct list.
    const groups = await this.prisma.catalogItem.groupBy({
      by: ['game'],
      where: { skus: { some: { inventory: { isNot: null } } } },
    });

    const games = groups
      .map((group) => group.game)
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''));

    // Then the count each option will actually yield. A handful of queries on
    // a rarely-hit endpoint, in exchange for a number that matches the list.
    return Promise.all(
      games.map(async (game) => ({
        game,
        items: await this.prisma.inventoryItem.count({
          where: { sku: { catalogItem: { game } } },
        }),
      })),
    );
  }

  /**
   * Every listing one channel should be advertising, for a file export
   * (ADR 0002).
   *
   * Goes through the same `toSnapshot` the rest of this service uses rather
   * than deriving quantities in a query. The allocation maths has one authority
   * (§4) and a second implementation of it — even a read-only one — is how the
   * two quietly stop agreeing.
   *
   * Unpaginated by design: an export is the whole channel or it is not an
   * export. A seller with a very large inventory pays for that in memory once,
   * on an operation they triggered.
   */
  async listChannelListings(channelInstanceId: string): Promise<ChannelListing[]> {
    const rows = await this.prisma.inventoryItem.findMany({
      where: { allocations: { some: { channelInstanceId } } },
      include: { allocations: true, sku: { include: { catalogItem: true } } },
      orderBy: { id: 'asc' },
    });

    const listings: ChannelListing[] = [];

    for (const row of rows) {
      const snapshot = toSnapshot(row);
      const allocation = snapshot.allocations.find(
        (a) => a.channelInstanceId === channelInstanceId,
      );
      // Unreachable: the query selected on this allocation existing. Present
      // because the type says it might not, and an assertion here would be a
      // worse answer than skipping a row.
      if (!allocation) continue;

      listings.push({
        allocationId: allocation.id,
        externalListingId: allocation.externalListingId,
        quantity: allocation.desiredListedQuantity,
        listedQuantity: allocation.listedQuantity,
        status: allocation.status,
        price: allocation.price,
        currency: allocation.currency,
        sku: {
          skuId: row.skuId,
          name: row.sku.catalogItem.name,
          condition: row.sku.condition,
          printing: row.sku.printing,
          language: row.sku.language,
          ...(row.sku.catalogItem.game ? { game: row.sku.catalogItem.game } : {}),
          ...(row.sku.catalogItem.setName ? { setName: row.sku.catalogItem.setName } : {}),
        },
      });
    }

    return listings;
  }

  /** Create a catalog item, SKU and inventory row together. */
  async createInventoryItem(input: CreateInventoryInput): Promise<LedgerSnapshot> {
    const name = input.name.trim();
    const printing = input.printing?.trim() || 'NORMAL';
    const language = input.language?.trim() || 'EN';

    const item = await this.prisma.$transaction(async (tx) => {
      const catalogItem = await tx.catalogItem.create({
        data: {
          name,
          searchName: name.toLowerCase(),
          game: input.game ?? null,
          setName: input.setName ?? null,
          ...(input.externalSource && input.externalId
            ? {
                externalRefs: {
                  create: [{ source: input.externalSource, externalId: input.externalId }],
                },
              }
            : {}),
        },
      });

      const sku = await tx.sku.create({
        data: { catalogItemId: catalogItem.id, condition: input.condition, printing, language },
      });

      return tx.inventoryItem.create({
        data: {
          skuId: sku.id,
          quantityOnHand: input.quantityOnHand ?? 0,
          costBasis: input.costBasis ?? null,
        },
        include: { allocations: true },
      });
    });

    if ((input.quantityOnHand ?? 0) > 0) {
      await this.prisma.stockMovement.create({
        data: {
          inventoryItemId: item.id,
          delta: input.quantityOnHand!,
          resultingOnHand: input.quantityOnHand!,
          reason: 'intake',
          actorUserId: input.actorUserId ?? null,
        },
      });
    }

    return toSnapshot(item);
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
            // Absent means "leave it alone", so an operator editing a price
            // cannot silently detach the listing link. Explicit null clears it.
            ...(write.externalListingId !== undefined
              ? { externalListingId: write.externalListingId }
              : {}),
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

      // listedQuantity is deliberately NOT written here. It records what we
      // believe the channel is actually advertising, and until a push succeeds
      // that is still the old value. Writing it optimistically would make
      // reconciliation compare our guess against the channel and conclude
      // there is no drift precisely when there is. The outbound worker sets it
      // after a successful push.
      await this.enqueuePushes(changes);

      return { ledger, changes, conflicts: outcome.conflicts ?? [] };
    }

    throw new ConflictException(
      `Inventory item ${inventoryItemId} is being modified concurrently; ` +
        `gave up after ${MAX_ATTEMPTS} attempts.`,
    );
  }

  /**
   * Queue an outbound push for every channel whose advertised quantity moved
   * (§6 steps 2–3).
   *
   * Deliberately best-effort. A quantity change is already committed by the
   * time this runs, and failing the operator's request because Redis was
   * briefly unreachable would be worse than a listing that catches up at the
   * next change or at reconciliation. The failure is logged rather than
   * swallowed silently.
   */
  private async enqueuePushes(changes: ListedQuantityChange[]): Promise<void> {
    if (!this.outbound || changes.length === 0) return;

    const channelKeys = new Map<string, string>();

    for (const change of changes) {
      try {
        let connectorKey = channelKeys.get(change.channelInstanceId);
        if (!connectorKey) {
          const channel = await this.prisma.channelInstance.findUnique({
            where: { id: change.channelInstanceId },
            select: { connectorKey: true, enabled: true },
          });
          if (!channel?.enabled) continue;
          connectorKey = channel.connectorKey;
          channelKeys.set(change.channelInstanceId, connectorKey);
        }

        await this.outbound.enqueue(connectorKey, {
          channelInstanceId: change.channelInstanceId,
          allocationId: change.allocationId,
          operation: 'quantity',
        });
      } catch (error) {
        this.logger.error(
          `Could not queue push for allocation ${change.allocationId}: ${(error as Error).message}`,
        );
      }
    }
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
