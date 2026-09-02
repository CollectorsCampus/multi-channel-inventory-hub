import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogMergeService, type MergeReport } from './catalog-merge.service';

/**
 * Merging one game's catalog rows into another's, matched by collector number.
 *
 * ## The situation this exists for, measured on 2026-09-01
 *
 * A game arrives before any marketplace catalogue carries it, so its cards are
 * taken in through a stopgap source — Bushiroad's own database for Palworld,
 * the hand-built import for Neuroscape. When the real source opens (TCGPlayer
 * opened Palworld as category 91), its ingest creates *separate* rows: the two
 * sources share no id namespace, so nothing converges. That much the
 * duplicates screen was built for — but it cannot see these pairs, because it
 * groups by `(game, searchName)` and the sources agree on **neither**:
 *
 * | Field | Bushiroad `palworld`                                | tcgcsv                              |
 * | ----- | --------------------------------------------------- | ----------------------------------- |
 * | game  | `Palworld`                                          | `Palworld OFFICIAL CARD GAME`       |
 * | name  | `Jormuntide Ignis – Savage Lava Dragon - EBP01-001` | `Jormuntide Ignis - Savage Lava Dragon` |
 * | number| `EBP01-001`                                         | `EBP01-001`                         |
 *
 * The one field they agree on — verbatim, parallels included (`EBP01-001OSR`)
 * — is the collector number, and within one game's rows those were measured
 * unique on both sides. So the pairing key is the number, and the judgement
 * the hub must not make — "are these two games the same game?" — is made by
 * the operator, who names both explicitly. That keeps the never-guess rule:
 * within the operator's assertion, everything here is exact equality.
 *
 * ## Which side survives, and why it is not a choice
 *
 * The `into` side wins every pair. That is not arbitrary: the surviving row's
 * `setName` is what the repricing sweep matches against tcgcsv's own set list
 * (exact equality — the 0.10.2 lesson), so a Bushiroad-spelled survivor would
 * leave every Palworld single permanently unpriceable. The whole point of
 * merging toward the marketplace source is that its spellings are the ones
 * the rest of the machinery already understands. The stopgap side's refs move
 * onto the survivor, so its ids keep resolving — the same permanence argument
 * the duplicates panel's merge makes.
 *
 * ## What is refused rather than resolved
 *
 * - A number matching more than one row on either side — ambiguity is
 *   reported, never picked from (the `propose` tie rule).
 * - A pair whose two rows share a ref namespace with different ids — that
 *   source itself says they are different products, and its word outranks a
 *   matching number.
 * - Per-pair merge refusals (a duplicate SKU holding stock or history) come
 *   from `CatalogMergeService` unchanged and are reported per row; the rest
 *   of the run still lands.
 */

export interface GameMergePair {
  collectorNumber: string;
  fromId: string;
  fromName: string;
  intoId: string;
  intoName: string;
  /** What the merge would move — the operator's reason to look twice. */
  skuCount: number;
  allocationCount: number;
}

export interface GameMergeSkip {
  collectorNumber: string | null;
  name: string;
  reason: string;
}

export interface GameMergePreview {
  fromGame: string;
  intoGame: string;
  pairs: GameMergePair[];
  skipped: GameMergeSkip[];
}

export interface GameMergeReport extends GameMergePreview {
  merged: number;
  problems: Array<{ collectorNumber: string; message: string }>;
}

/** The import cap's argument: refuse a run too large to have been reviewed. */
const MAX_PAIRS = 1000;

@Injectable()
export class CatalogGameMergeService {
  private readonly logger = new Logger(CatalogGameMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly merge: CatalogMergeService,
  ) {}

  async preview(fromGame: string, intoGame: string): Promise<GameMergePreview> {
    if (fromGame === intoGame) {
      throw new BadRequestException('The two games must differ — a game cannot merge into itself.');
    }

    const select = {
      id: true,
      name: true,
      collectorNumber: true,
      externalRefs: { select: { source: true } },
      skus: {
        select: { id: true, inventory: { select: { allocations: { select: { id: true } } } } },
      },
    } as const;

    const [fromItems, intoItems] = await Promise.all([
      this.prisma.catalogItem.findMany({ where: { game: fromGame }, select }),
      this.prisma.catalogItem.findMany({ where: { game: intoGame }, select }),
    ]);

    // A game with no rows is a typo or a stale dropdown, and pairing nothing
    // "successfully" would read as a finished migration that never ran.
    if (fromItems.length === 0) {
      throw new BadRequestException(`No catalog items carry the game "${fromGame}".`);
    }
    if (intoItems.length === 0) {
      throw new BadRequestException(`No catalog items carry the game "${intoGame}".`);
    }

    const intoByNumber = new Map<string, typeof intoItems>();
    for (const item of intoItems) {
      if (item.collectorNumber === null) continue;
      const list = intoByNumber.get(item.collectorNumber) ?? [];
      list.push(item);
      intoByNumber.set(item.collectorNumber, list);
    }

    const fromByNumber = new Map<string, number>();
    for (const item of fromItems) {
      if (item.collectorNumber !== null) {
        fromByNumber.set(item.collectorNumber, (fromByNumber.get(item.collectorNumber) ?? 0) + 1);
      }
    }

    const pairs: GameMergePair[] = [];
    const skipped: GameMergeSkip[] = [];

    for (const item of fromItems) {
      const number = item.collectorNumber;
      if (number === null) {
        skipped.push({
          collectorNumber: null,
          name: item.name,
          reason: 'has no collector number to match on',
        });
        continue;
      }
      if ((fromByNumber.get(number) ?? 0) > 1) {
        skipped.push({
          collectorNumber: number,
          name: item.name,
          reason: `"${number}" appears on more than one ${fromGame} item — ambiguous`,
        });
        continue;
      }
      const counterparts = intoByNumber.get(number) ?? [];
      if (counterparts.length === 0) {
        skipped.push({
          collectorNumber: number,
          name: item.name,
          reason: `no ${intoGame} item carries "${number}"`,
        });
        continue;
      }
      if (counterparts.length > 1) {
        skipped.push({
          collectorNumber: number,
          name: item.name,
          reason: `"${number}" appears on ${counterparts.length} ${intoGame} items — ambiguous`,
        });
        continue;
      }

      const into = counterparts[0]!;
      const shared = item.externalRefs
        .map((r) => r.source)
        .filter((s) => into.externalRefs.some((r) => r.source === s));
      if (shared.length > 0) {
        skipped.push({
          collectorNumber: number,
          name: item.name,
          reason:
            `both sides carry ${shared.join(', ')} ids that differ — ` +
            `that source says they are different products`,
        });
        continue;
      }

      pairs.push({
        collectorNumber: number,
        fromId: item.id,
        fromName: item.name,
        intoId: into.id,
        intoName: into.name,
        skuCount: item.skus.length,
        allocationCount: item.skus.reduce(
          (sum, sku) => sum + (sku.inventory?.allocations.length ?? 0),
          0,
        ),
      });
    }

    if (pairs.length > MAX_PAIRS) {
      throw new BadRequestException(
        `${pairs.length} pairs exceeds the limit of ${MAX_PAIRS} for one run.`,
      );
    }

    pairs.sort((a, b) => a.collectorNumber.localeCompare(b.collectorNumber));
    return { fromGame, intoGame, pairs, skipped };
  }

  /**
   * Re-derives the pairing rather than trusting a client-submitted list, for
   * the reason `confirm` re-fetches candidates: the rows are re-read at the
   * moment of writing, so a merge that landed between preview and confirm
   * cannot be replayed against the wrong rows.
   */
  async mergeGames(fromGame: string, intoGame: string): Promise<GameMergeReport> {
    const plan = await this.preview(fromGame, intoGame);

    let merged = 0;
    const problems: GameMergeReport['problems'] = [];

    // Sequential, like match confirmation: one refused pair reports its
    // problem and the rest still land.
    for (const pair of plan.pairs) {
      try {
        const report: MergeReport = await this.merge.merge(pair.intoId, pair.fromId);
        merged += 1;
        this.logger.log(
          `Game merge ${pair.collectorNumber}: "${pair.fromName}" -> "${pair.intoName}" ` +
            `(${report.movedSkus} SKU(s) moved).`,
        );
      } catch (error) {
        const message =
          error instanceof BadRequestException
            ? JSON.stringify(error.getResponse())
            : error instanceof Error
              ? error.message
              : String(error);
        problems.push({ collectorNumber: pair.collectorNumber, message });
      }
    }

    this.logger.log(
      `Merged game "${fromGame}" into "${intoGame}": ${merged} of ${plan.pairs.length} ` +
        `pair(s) merged, ${plan.skipped.length} skipped, ${problems.length} problem(s).`,
    );
    return { ...plan, merged, problems };
  }
}
