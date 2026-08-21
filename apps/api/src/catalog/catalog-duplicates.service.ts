import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Finding catalog items that are one real product — and only reporting them.
 *
 * `docs/CATALOG_DUPLICATES.md` is the spec. Two sources converge only where
 * they share an id namespace, so a Magic card taken in through Scryfall with no
 * `tcgplayer_id` becomes its own row beside the tcgcsv one. This service finds
 * those pairs; **merging is deliberately absent** — it moves SKUs, allocations
 * and live listing links, and that is the operator's call, made per group, not
 * a heuristic's.
 *
 * ## Why disjoint ref namespaces is the gate, not name similarity
 *
 * Same-named rows within a game are overwhelmingly *reprints* — a real
 * "Charizard ex" exists in several sets, and reporting those would bury the
 * genuine duplicates under exactly the noise that makes a review screen
 * unreadable. But a reprint pair created by one source shares that source's
 * namespace on both rows, while a convergence failure by construction does
 * not: one row carries `{scryfall}`, the other `{tcgcsv, tcgplayer}`, and had
 * they shared any namespace `resolveCatalogItem` would have merged them at
 * intake. Disjointness is not a heuristic for the failure — it is the
 * failure's definition.
 *
 * ## Ranking, in the operator's terms
 *
 * - **`number`**: both rows carry a collector number and they match, verbatim.
 *   Within one game and one name, that is as close to certainty as exists
 *   without a shared id — it is why the column was added.
 * - **`number-differs`** pairs are *excluded*, not ranked low: same name,
 *   different printed number is what a reprint looks like, and offering it
 *   invites a merge that would fuse two real products — the split this ledger
 *   exists to prevent, in the other direction.
 * - **`image`**: no number on one side or both, but the stored image URL is
 *   byte-identical — two rows pointing at the same CDN asset.
 * - **`name`**: nothing but the name (and disjointness) to go on. Offered
 *   last, because the operator decides, but offered: on the measured data this
 *   is what a Secret Lair duplicate looks like, since Scryfall had no
 *   TCGPlayer id and the sets are spelled differently.
 */

export interface DuplicateItem {
  id: string;
  name: string;
  setName: string | null;
  collectorNumber: string | null;
  imageUrl: string | null;
  createdAt: Date;
  /** `source: externalId`, the thing that decides which row is which. */
  refs: Array<{ source: string; externalId: string }>;
  /** What hangs off this row — what a merge would have to move. */
  skuCount: number;
  allocationCount: number;
}

export type DuplicateConfidence = 'number' | 'image' | 'name';

export interface DuplicateGroup {
  game: string | null;
  name: string;
  confidence: DuplicateConfidence;
  items: DuplicateItem[];
}

@Injectable()
export class CatalogDuplicatesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every group of same-named, ref-disjoint items, strongest evidence first.
   *
   * One pass over `(game, searchName)` groups with more than one row. The
   * whole catalogue's duplicate-candidate set is bounded by names that repeat
   * at all, which `groupBy` answers in one query; only those groups are then
   * loaded. On the measured copy that is hundreds of names out of 23k rows,
   * nearly all of them reprints the disjointness gate then drops.
   */
  async findDuplicates(): Promise<DuplicateGroup[]> {
    const repeated = await this.prisma.catalogItem.groupBy({
      by: ['game', 'searchName'],
      having: { searchName: { _count: { gt: 1 } } },
      _count: true,
    });
    if (repeated.length === 0) return [];

    const groups: DuplicateGroup[] = [];

    for (const key of repeated) {
      const items = await this.prisma.catalogItem.findMany({
        where: { game: key.game, searchName: key.searchName },
        include: {
          externalRefs: { select: { source: true, externalId: true } },
          skus: {
            select: { id: true, inventory: { select: { allocations: { select: { id: true } } } } },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      // Partition into clusters of mutually ref-disjoint rows: start each item
      // in its own cluster, then merge clusters that share a namespace. What
      // remains as *separate* clusters within one name is the duplicate
      // candidate set; a name whose rows all share namespaces collapses to one
      // cluster and is reported as nothing.
      const clusters: Array<{ namespaces: Set<string>; items: typeof items }> = [];
      for (const item of items) {
        const namespaces = new Set(item.externalRefs.map((r) => r.source));
        const overlapping = clusters.filter((c) =>
          [...namespaces].some((n) => c.namespaces.has(n)),
        );
        const merged = { namespaces, items: [item] };
        for (const cluster of overlapping) {
          for (const n of cluster.namespaces) merged.namespaces.add(n);
          merged.items.push(...cluster.items);
          clusters.splice(clusters.indexOf(cluster), 1);
        }
        clusters.push(merged);
      }

      if (clusters.length < 2) continue;

      const flat = clusters.flatMap((c) => c.items);

      // Reprints: every row numbered, and no two numbers equal — a family of
      // distinct printings that happen to share a name. Not a duplicate.
      const numbers = flat.map((i) => i.collectorNumber).filter((n): n is string => n !== null);
      const allNumberedDistinct =
        numbers.length === flat.length && new Set(numbers).size === numbers.length;
      if (allNumberedDistinct) continue;

      const sameNumber =
        numbers.length === flat.length && new Set(numbers).size === 1 && flat.length > 1;
      const images = flat.map((i) => i.imageUrl).filter((u): u is string => u !== null);
      const sameImage =
        images.length === flat.length && new Set(images).size === 1 && flat.length > 1;

      groups.push({
        game: key.game,
        name: flat[0]!.name,
        confidence: sameNumber ? 'number' : sameImage ? 'image' : 'name',
        items: flat.map((item) => ({
          id: item.id,
          name: item.name,
          setName: item.setName,
          collectorNumber: item.collectorNumber,
          imageUrl: item.imageUrl,
          createdAt: item.createdAt,
          refs: item.externalRefs,
          skuCount: item.skus.length,
          allocationCount: item.skus.reduce(
            (sum, sku) => sum + (sku.inventory?.allocations.length ?? 0),
            0,
          ),
        })),
      });
    }

    const rank: Record<DuplicateConfidence, number> = { number: 0, image: 1, name: 2 };
    return groups.sort(
      (a, b) => rank[a.confidence] - rank[b.confidence] || a.name.localeCompare(b.name),
    );
  }
}
