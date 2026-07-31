import { Injectable, Logger } from '@nestjs/common';
import type {
  CatalogCandidate,
  CatalogCtx,
  CatalogSearchQuery,
  CatalogSource,
} from '@hub/connector-sdk';
import { CatalogSourceRegistry, type AttributedCandidate } from './catalog-source-registry.service';
import { MinIntervalLimiter, intervalFor } from './rate-limiter';
// Not `import type` — Nest injects this, and a type-only import degrades
// `design:paramtypes` to Object and fails DI at runtime (rule 7).
import { PrismaService } from '../prisma/prisma.service';

/**
 * Catalog search for the intake flow (§7).
 *
 * Sources are third-party services, so this never lets one of them fail the
 * whole request — `failures` comes back alongside the results and the UI says
 * which source was unreachable.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly registry: CatalogSourceRegistry,
    private readonly prisma: PrismaService,
  ) {}

  async search(query: CatalogSearchQuery) {
    return this.registry.search((source) => this.makeCtx(source), query);
  }

  /**
   * Search the local catalog — what has been ingested, not what a source will
   * say.
   *
   * This is the half of the ingest that makes it useful rather than merely
   * durable. tcgcsv refuses an un-narrowed search by design, so before this
   * existed a caller had to already know a set's name to find anything in it,
   * and working out which sets a real store held meant reading group lists by
   * hand. Here the question "what do we know about Pokemon?" is answerable.
   *
   * Matches on `searchName`, the pre-lowercased copy maintained on write. That
   * column exists precisely so this comparison is identical on PostgreSQL, MySQL
   * and SQLite — Prisma's `mode: "insensitive"` is PostgreSQL-only (§3).
   */
  async searchLocal(query: CatalogSearchQuery): Promise<AttributedCandidate[]> {
    const text = query.text?.trim().toLowerCase() ?? '';
    const setName = query.setName?.trim();

    // Prisma accepts either an exact string or a filter object here.
    const find = (setFilter: string | { contains: string } | undefined) =>
      this.prisma.catalogItem.findMany({
        where: {
          ...(text !== '' ? { searchName: { contains: text } } : {}),
          ...(query.game !== undefined ? { game: query.game } : {}),
          ...(setFilter !== undefined ? { setName: setFilter } : {}),
        },
        select: {
          name: true,
          game: true,
          setName: true,
          imageUrl: true,
          externalRefs: { select: { source: true, externalId: true } },
        },
        // Stable and useful: a set reads in name order rather than insertion order.
        orderBy: [{ setName: 'asc' }, { searchName: 'asc' }],
        take: query.limit ?? 50,
      });

    let items = await find(setName === undefined || setName === '' ? undefined : setName);

    // Exact first, then containment — the same order tcgcsv's own matcher uses,
    // and necessary rather than generous. Sources store a set under its
    // catalogue name ("ME02: Phantasmal Flames") while an operator types the one
    // on the box ("Phantasmal Flames"). Without this the local catalog silently
    // misses on the spelling people actually use, falls through to the network,
    // and looks like it is not working while quietly working.
    //
    // Case-sensitive, deliberately: there is no lowercased copy of `setName` the
    // way `searchName` exists for names, and `mode: "insensitive"` is
    // PostgreSQL-only (§3). Callers wanting certainty should take a name from
    // `listLocalSets` rather than typing one.
    if (items.length === 0 && setName !== undefined && setName !== '') {
      items = await find({ contains: setName });
    }

    const candidates: AttributedCandidate[] = [];
    for (const item of items) {
      const externalIds: Record<string, string> = {};
      for (const ref of item.externalRefs) externalIds[ref.source] = ref.externalId;

      // An item with no refs cannot be re-verified or linked, so returning it
      // would offer the operator something they cannot act on.
      const attribution = pickAttribution(item.externalRefs);
      if (!attribution) continue;

      candidates.push({
        sourceKey: attribution.source,
        sourceId: attribution.externalId,
        name: item.name,
        externalIds,
        ...(item.game !== null ? { game: item.game } : {}),
        ...(item.setName !== null ? { setName: item.setName } : {}),
        ...(item.imageUrl !== null ? { imageUrl: item.imageUrl } : {}),
      });
    }

    return candidates;
  }

  /**
   * Sets the local catalog holds, with how much of each.
   *
   * The browse entry point: it answers "what is in here" without a set name,
   * which is the question no remote source here will take.
   */
  async listLocalSets(
    game?: string,
  ): Promise<Array<{ game: string | null; setName: string; items: number }>> {
    const groups = await this.prisma.catalogItem.groupBy({
      by: ['game', 'setName'],
      where: {
        setName: { not: null },
        ...(game !== undefined ? { game } : {}),
      },
      _count: { _all: true },
      orderBy: [{ game: 'asc' }, { setName: 'asc' }],
    });

    return groups
      .filter((g): g is typeof g & { setName: string } => g.setName !== null)
      .map((g) => ({ game: g.game, setName: g.setName, items: g._count._all }));
  }

  /**
   * Re-fetch one candidate from its source.
   *
   * Intake goes through this rather than trusting the candidate the browser
   * sends back. The client would otherwise be free to supply any name, image or
   * external id it liked, and those get written straight into the catalog —
   * `CatalogExternalRef` in particular is what every future listing is keyed
   * on, so a forged id there is not a cosmetic problem.
   */
  async fetchCandidate(sourceKey: string, sourceId: string): Promise<AttributedCandidate | null> {
    const source = this.registry.get(sourceKey);

    // The local catalog first, when it already holds this id.
    //
    // Not a cache — it is the more authoritative of the two for this question.
    // The whole reason to re-fetch rather than trust the client is that the
    // caller must not choose what gets written to `CatalogExternalRef`; a row we
    // already wrote satisfies that completely, and does so without a network
    // call to a community CDN that may be down, rate-limiting, or 401ing.
    //
    // It also fixes a failure reproduced on a live run: tcgcsv's `fetchById`
    // resolves only from sets read into memory, so every confirmation after a
    // container restart failed with "tcgcsv has no product …" until the set was
    // downloaded again. Ingested products no longer depend on process lifetime.
    const local = await this.fetchLocal(source.key, sourceId);
    if (local) return local;

    if (typeof source.fetchById !== 'function') {
      // A source without fetchById cannot be re-verified. Callers decide
      // whether to accept client-supplied data; they are told plainly here.
      this.logger.warn(`Catalog source "${sourceKey}" cannot re-fetch by id.`);
      return null;
    }

    const candidate = await this.limiter.run(source.key, intervalFor(source.rateLimit), () =>
      source.fetchById!(this.makeCtx(source), sourceId),
    );

    return candidate ? { ...candidate, sourceKey: source.key } : null;
  }

  /**
   * A candidate rebuilt from the local catalog, if this id is already stored.
   *
   * Returns every external id the item carries, not just the one asked for, so
   * the shape matches what a source would have returned and callers keep
   * backfilling ids as they always did.
   *
   * Deliberately carries no `marketPrice`: the ingest does not store prices,
   * because they change daily and a stored one is a stale one. A caller that
   * needs a live price should ask the source for it explicitly rather than
   * receive a silently absent field here — which is why this is documented
   * rather than quietly filled with zero.
   */
  private async fetchLocal(
    sourceKey: string,
    sourceId: string,
  ): Promise<AttributedCandidate | null> {
    const ref = await this.prisma.catalogExternalRef.findUnique({
      where: { source_externalId: { source: sourceKey, externalId: sourceId } },
      select: {
        catalogItem: {
          select: {
            name: true,
            game: true,
            setName: true,
            imageUrl: true,
            externalRefs: { select: { source: true, externalId: true } },
          },
        },
      },
    });
    if (!ref?.catalogItem) return null;

    const item = ref.catalogItem;
    const externalIds: Record<string, string> = {};
    for (const r of item.externalRefs) externalIds[r.source] = r.externalId;

    return {
      sourceKey,
      sourceId,
      name: item.name,
      externalIds,
      ...(item.game !== null ? { game: item.game } : {}),
      ...(item.setName !== null ? { setName: item.setName } : {}),
      ...(item.imageUrl !== null ? { imageUrl: item.imageUrl } : {}),
    };
  }

  /**
   * True when this *source* can re-verify by id.
   *
   * Deliberately still only about the source, even though `fetchCandidate` can
   * now answer from the local catalog: this takes no product id, so it cannot
   * know whether any particular product was ingested. Callers use it to phrase
   * an error before trying, and a "yes" here has never meant a given id will
   * resolve.
   */
  canRefetch(sourceKey: string): boolean {
    return typeof this.registry.get(sourceKey).fetchById === 'function';
  }

  listSources() {
    return this.registry.list();
  }

  private makeCtx(source: CatalogSource): CatalogCtx {
    const context = `catalog:${source.key}`;
    return {
      // Public sources need nothing. Sources declaring secretFields will read
      // from the credential store once any of them exist.
      secrets: {},
      logger: {
        debug: (m) => this.logger.debug(m, context),
        info: (m) => this.logger.log(m, context),
        warn: (m) => this.logger.warn(m, context),
        error: (m) => this.logger.error(m, context),
      },
    };
  }
}

/**
 * Which of an item's external ids to present it under.
 *
 * An item can carry several — a tcgcsv ingest records both `tcgcsv` and
 * `tcgplayer` for the same product — and a candidate needs exactly one
 * `(sourceKey, sourceId)` pair, because that pair is what `fetchCandidate` is
 * later asked to re-verify.
 *
 * Preference order is by usefulness downstream rather than alphabetical:
 * `tcgcsv` first because it is the source that can still be re-fetched live if
 * the local row is ever missing, then `tcgplayer` because it is the id a
 * marketplace listing is keyed on, then whatever else exists. Sorted before
 * picking so the choice does not depend on database row order.
 *
 * Exported so that listing creation stamps a SKU code under the same
 * attribution a later proposal run will present the item under. Two
 * implementations of this choice would disagree eventually, and the symptom
 * would be a `hub-sku` code on a live storefront that the matcher no longer
 * recognises as its own.
 */
export function pickAttribution(
  refs: ReadonlyArray<{ source: string; externalId: string }>,
): { source: string; externalId: string } | undefined {
  const preference = ['tcgcsv', 'tcgplayer', 'scryfall'];

  const ranked = [...refs].sort((a, b) => {
    const ai = preference.indexOf(a.source);
    const bi = preference.indexOf(b.source);
    return (ai === -1 ? preference.length : ai) - (bi === -1 ? preference.length : bi);
  });

  return ranked[0];
}

export type { CatalogCandidate };
