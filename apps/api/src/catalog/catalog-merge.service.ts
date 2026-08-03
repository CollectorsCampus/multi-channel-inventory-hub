import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Merging two catalog items that turn out to be the same real product.
 *
 * ## Why this has to exist
 *
 * `resolveCatalogItem` joins a candidate to an item by **external reference**,
 * never by name. That is right — two printings share a name, and a renamed
 * product must still resolve — but it means two sources with no id in common
 * produce two items for one card. Today Scryfall and tcgcsv both happen to emit
 * a `tcgplayer` id, so they converge; that is luck, not design, and CardTrader's
 * `blueprint_id` shares an id space with nothing.
 *
 * Once split, everything downstream inherits it: each item gets its own SKUs,
 * its own allocations, and its own idea of the stock. That is the double-sell
 * this ledger exists to prevent, arriving through the catalogue rather than the
 * sync loop.
 *
 * ## Why it refuses so much
 *
 * **`CatalogItem` cascades all the way down.** `Sku` → `InventoryItem` →
 * `StockMovement` *and* `ChannelAllocation` are every one `onDelete: Cascade`,
 * so `DELETE FROM catalog_items` silently destroys stock, its links to live
 * listings, and the entire audit trail for that card. There is no undo and no
 * record that it happened.
 *
 * So this validates **completely before it writes anything**, and refuses
 * rather than deciding anything about quantities. A merge here only ever
 * repoints rows; it never adds, moves or discards a single unit. Anything that
 * would require judgement about stock is handed back to the operator with the
 * exact rows named — for the same reason `propose` reports a tie instead of
 * picking one.
 */

/** A SKU on the loser that the winner already has, and cannot absorb. */
export interface MergeBlocker {
  skuId: string;
  condition: string;
  printing: string;
  language: string;
  reason: string;
}

export interface MergeReport {
  winnerId: string;
  loserId: string;
  /** SKUs repointed at the winner. */
  movedSkus: number;
  /** Empty duplicate SKUs removed with the loser. */
  discardedSkus: number;
  /** Platform ids the winner gained. */
  movedRefs: Array<{ source: string; externalId: string }>;
}

type LoserSku = {
  id: string;
  condition: string;
  printing: string;
  language: string;
  inventory: {
    id: string;
    quantityOnHand: number;
    reserveQuantity: number;
    _count: { allocations: number; movements: number };
  } | null;
};

@Injectable()
export class CatalogMergeService {
  private readonly logger = new Logger(CatalogMergeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fold `loserId` into `winnerId`.
   *
   * The winner keeps its identity — its id is what every `Sku`, and therefore
   * every allocation and every hub SKU code already written to a storefront,
   * hangs off. Choosing which survives is the operator's call precisely because
   * it decides whose links stay valid.
   */
  async merge(winnerId: string, loserId: string): Promise<MergeReport> {
    if (winnerId === loserId) {
      throw new BadRequestException('An item cannot be merged into itself.');
    }

    const [winner, loser] = await Promise.all([
      this.prisma.catalogItem.findUnique({
        where: { id: winnerId },
        select: { id: true, name: true, skus: { select: SKU_KEY } },
      }),
      this.prisma.catalogItem.findUnique({
        where: { id: loserId },
        select: {
          id: true,
          name: true,
          externalRefs: { select: { id: true, source: true, externalId: true } },
          skus: {
            select: {
              ...SKU_KEY,
              inventory: {
                select: {
                  id: true,
                  quantityOnHand: true,
                  reserveQuantity: true,
                  _count: { select: { allocations: true, movements: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    if (!winner) throw new NotFoundException(`Catalog item ${winnerId} not found.`);
    if (!loser) throw new NotFoundException(`Catalog item ${loserId} not found.`);

    // Keyed on the natural key, because that is what `Sku`'s unique constraint
    // is and therefore what decides whether a row can simply be repointed.
    const taken = new Set(winner.skus.map(keyOf));

    const toMove: LoserSku[] = [];
    const toDiscard: LoserSku[] = [];
    const blockers: MergeBlocker[] = [];

    for (const sku of loser.skus as LoserSku[]) {
      if (!taken.has(keyOf(sku))) {
        toMove.push(sku);
        continue;
      }

      // The winner already has this exact condition/printing/language. The
      // loser's copy can only go if nothing ever happened to it — otherwise
      // merging would mean deciding what to do with real stock, real links to
      // live listings, or a real history, and none of those is this function's
      // to decide.
      const blocker = describeBlocker(sku);
      if (blocker) blockers.push(blocker);
      else toDiscard.push(sku);
    }

    if (blockers.length > 0) {
      throw new BadRequestException({
        message:
          `"${loser.name}" cannot be merged into "${winner.name}": ${blockers.length} of its ` +
          `SKUs already exist on the winner and still hold stock, allocations or history. ` +
          `Move or zero those first — merging cannot decide what happens to them.`,
        blockers,
      });
    }

    // Everything below is a write, and only now that nothing can refuse.
    await this.prisma.$transaction(async (tx) => {
      for (const sku of toMove) {
        await tx.sku.update({ where: { id: sku.id }, data: { catalogItemId: winnerId } });
      }

      for (const ref of loser.externalRefs) {
        // Safe to repoint rather than create-and-catch: the unique index is on
        // (source, externalId), and these rows currently hold those pairs, so
        // there is nothing to collide with.
        await tx.catalogExternalRef.update({
          where: { id: ref.id },
          data: { catalogItemId: winnerId },
        });
      }

      // Whatever is left on the loser is provably empty, so the cascade has
      // nothing of value to take with it.
      await tx.catalogItem.delete({ where: { id: loserId } });
    });

    this.logger.log(
      `Merged catalog item ${loserId} ("${loser.name}") into ${winnerId} ("${winner.name}"): ` +
        `${toMove.length} SKU(s) moved, ${toDiscard.length} empty duplicate(s) discarded, ` +
        `${loser.externalRefs.length} external ref(s) moved.`,
    );

    return {
      winnerId,
      loserId,
      movedSkus: toMove.length,
      discardedSkus: toDiscard.length,
      movedRefs: loser.externalRefs.map(({ source, externalId }) => ({ source, externalId })),
    };
  }
}

const SKU_KEY = { id: true, condition: true, printing: true, language: true } as const;

function keyOf(sku: { condition: string; printing: string; language: string }): string {
  return `${sku.condition}|${sku.printing}|${sku.language}`;
}

/**
 * Why a duplicate SKU cannot simply be dropped, or null when it can.
 *
 * Deliberately strict: a movement history with no stock still records that
 * something happened to this row, and deleting it would remove an audit trail
 * the ledger promises to keep.
 */
function describeBlocker(sku: LoserSku): MergeBlocker | null {
  const { inventory } = sku;
  const base = {
    skuId: sku.id,
    condition: sku.condition,
    printing: sku.printing,
    language: sku.language,
  };

  if (!inventory) return null;
  if (inventory.quantityOnHand !== 0) {
    return { ...base, reason: `holds ${inventory.quantityOnHand} on hand` };
  }
  if (inventory.reserveQuantity !== 0) {
    return { ...base, reason: `reserves ${inventory.reserveQuantity}` };
  }
  if (inventory._count.allocations > 0) {
    return { ...base, reason: `is on ${inventory._count.allocations} channel(s)` };
  }
  if (inventory._count.movements > 0) {
    return { ...base, reason: `has ${inventory._count.movements} stock movement(s) on record` };
  }

  return null;
}
