import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Wiping catalogue identity data that ingest built, without ever touching
 * anything the ledger depends on.
 *
 * ## The one rule that makes this safe
 *
 * `CatalogMergeService`'s own documentation names the danger this shares:
 * `CatalogItem` cascades to `Sku`, and `Sku` cascades to `InventoryItem`,
 * `StockMovement` and `ChannelAllocation`. So this only ever touches a
 * `CatalogItem` with **no `Sku` at all** (`skus: { none: {} }`) — provably
 * inert, because nothing has ever been added to the ledger against it.
 * Deleting it destroys identity data an ingest can rebuild, and nothing else.
 *
 * A `CatalogItem` with even one `Sku` is kept, whatever that `Sku`'s
 * quantity — a zero-quantity `Sku` still means the operator added the card to
 * the ledger, or a listing was created against it, or it has a movement in
 * its history. Emptying an individual `Sku` is `CatalogMergeService`'s
 * question to answer, not this one's; this never reaches it, because the
 * `CatalogItem` that owns it is not in scope to begin with.
 *
 * ## Why the scope is a game, not a set
 *
 * Ingest is scoped per set; clearing is one level up. A mis-ingested set is
 * fixed by re-running it — `ensureCatalogItem`'s `refresh` overwrites in
 * place, so it needs no clear first. This is for starting a game over: a
 * source changed shape, a test run needs undoing, or the catalogue is being
 * rebuilt from a different source. `game` is matched exactly, the same as
 * everywhere else a game name crosses this boundary — it is a value the
 * caller read off `/catalog/local/sets`, never typed.
 */
export interface ClearScope {
  /** Omitted clears every game. */
  game?: string;
}

export interface ClearPreview {
  /** Items with no SKU — what a clear would remove. */
  clearable: number;
  /** Items with at least one SKU, whatever its stock. Never removed. */
  protectedCount: number;
}

export interface ClearReport extends ClearPreview {
  externalRefsRemoved: number;
}

@Injectable()
export class CatalogClearService {
  private readonly logger = new Logger(CatalogClearService.name);

  constructor(private readonly prisma: PrismaService) {}

  async preview(scope: ClearScope = {}): Promise<ClearPreview> {
    const where = scope.game !== undefined ? { game: scope.game } : {};

    const [clearable, protectedCount] = await Promise.all([
      this.prisma.catalogItem.count({ where: { ...where, skus: { none: {} } } }),
      this.prisma.catalogItem.count({ where: { ...where, skus: { some: {} } } }),
    ]);

    return { clearable, protectedCount };
  }

  /**
   * Delete everything in scope with no SKU.
   *
   * Counted immediately before deleting, in the same call, rather than trusting
   * a preview the operator may have looked at minutes ago — a `preview()` and a
   * `clear()` a moment apart could disagree if an ingest ran between them, and
   * the report should describe what this request actually did.
   */
  async clear(scope: ClearScope = {}): Promise<ClearReport> {
    const base = scope.game !== undefined ? { game: scope.game } : {};
    const clearableWhere = { ...base, skus: { none: {} } };

    const [clearable, protectedCount, externalRefsRemoved] = await Promise.all([
      this.prisma.catalogItem.count({ where: clearableWhere }),
      this.prisma.catalogItem.count({ where: { ...base, skus: { some: {} } } }),
      this.prisma.catalogExternalRef.count({ where: { catalogItem: clearableWhere } }),
    ]);

    if (clearable > 0) {
      // A real foreign key with ON DELETE CASCADE, not application-side
      // cleanup — the same guarantee `CatalogMergeService` relies on for its
      // loser row. Safe here only because `clearableWhere` already excludes
      // every item with a SKU, so the cascade has nothing beyond
      // `CatalogExternalRef` left to reach.
      await this.prisma.catalogItem.deleteMany({ where: clearableWhere });
    }

    this.logger.log(
      `Cleared ${clearable} catalog item(s)` +
        `${scope.game !== undefined ? ` for game "${scope.game}"` : ''}, ` +
        `${externalRefsRemoved} external ref(s) with them. ${protectedCount} kept for holding a SKU.`,
    );

    return { clearable, protectedCount, externalRefsRemoved };
  }
}
