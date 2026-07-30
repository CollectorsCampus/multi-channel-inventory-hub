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

export type { CatalogCandidate };
