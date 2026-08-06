import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  supportsBulkIngest,
  type CatalogCtx,
  type CatalogSetRef,
  type CatalogSource,
} from '@hub/connector-sdk';
import { CatalogSourceRegistry } from './catalog-source-registry.service';
import { MinIntervalLimiter, intervalFor } from './rate-limiter';
import { IntakeService } from '../inventory/intake.service';
import { CatalogCredentialsService } from './catalog-credentials.service';

/**
 * Filling the local catalog from a source, set by set.
 *
 * ## Why this exists
 *
 * `CatalogService` is a proxy: every search is a live call to a third party.
 * That is fine for intake, where an operator is looking one card up, and wrong
 * for everything else — three separate failures on a live run made the case:
 *
 * 1. **`fetchById` forgets on restart.** tcgcsv publishes no product-to-set
 *    index, so its `fetchById` can only resolve products from sets already read
 *    into memory. Confirming a match after a container restart failed with
 *    "tcgcsv has no product 654154" until the set was downloaded again.
 * 2. **You cannot browse.** An un-narrowed tcgcsv search throws by design, so a
 *    caller must already know the set name. Working out which sets a store
 *    actually held meant cross-referencing group lists against listing titles by
 *    hand.
 * 3. **It is a community CDN with no SLA**, refreshed once a day. Nothing that
 *    matters should be one 401 away from unavailable.
 *
 * Ingesting into `CatalogItem` and `CatalogExternalRef` fixes all three, and the
 * tcgcsv source has described this as its "honest production shape" since it was
 * written.
 *
 * ## What it deliberately does not store
 *
 * **Prices.** tcgcsv republishes them daily and they are the most volatile thing
 * it carries; a stored price is a stale price with a timestamp nobody checks.
 * Identity is durable, prices are not, so prices stay a live lookup. The schema
 * has nowhere to put one anyway, and adding a column to hold data with a
 * one-day half-life would be the wrong trade.
 *
 * **Per-condition rows.** tcgcsv has no SKU tier at all (see the source's own
 * header). `Sku` rows are created by intake and matching when an operator
 * actually holds something, not speculatively for every condition of every card
 * in existence.
 */

export interface IngestReport {
  sourceKey: string;
  /** Sets that were read. */
  sets: number;
  /** Products the source returned across those sets. */
  products: number;
  created: number;
  /** Existing items whose name, set or image had changed. */
  refreshed: number;
  /** Existing items that were already correct. Re-ingesting is mostly this. */
  unchanged: number;
  problems: Array<{ set: string; message: string }>;
  /** Wall-clock, because a full-game ingest is measured in minutes. */
  durationMs: number;
}

export interface IngestRequest {
  sourceKey: string;
  /** Narrow to one game. Omitted means everything the source lists. */
  game?: string;
  /** Ingest only these set ids. Omitted means every set `listSets` returns. */
  setIds?: readonly string[];
  /**
   * Stop after this many sets. A guard against "ingest everything" costing
   * thousands of requests before anyone notices.
   */
  maxSets?: number;
  signal?: AbortSignal;
}

/** Enough to be useful, small enough that a mistake is cheap. */
const DEFAULT_MAX_SETS = 50;

@Injectable()
export class CatalogIngestService {
  private readonly logger = new Logger(CatalogIngestService.name);
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly registry: CatalogSourceRegistry,
    private readonly intake: IntakeService,
    private readonly credentials: CatalogCredentialsService,
  ) {}

  /** Sets a source can offer, so a caller can choose before committing to a run. */
  async listSets(sourceKey: string, game?: string, signal?: AbortSignal): Promise<CatalogSetRef[]> {
    const source = this.registry.get(sourceKey);
    if (!supportsBulkIngest(source)) {
      throw new BadRequestException(
        `Catalog source "${source.key}" cannot be ingested: it does not enumerate its sets.`,
      );
    }

    const ctx = await this.makeCtx(source, signal);
    return this.limiter.run(source.key, intervalFor(source.rateLimit), () =>
      source.listSets!(ctx, game),
    );
  }

  async ingest(request: IngestRequest): Promise<IngestReport> {
    const startedAt = Date.now();
    const source = this.registry.get(request.sourceKey);

    if (!supportsBulkIngest(source)) {
      throw new BadRequestException(
        `Catalog source "${source.key}" cannot be ingested: it does not enumerate its sets.`,
      );
    }

    const ctx = await this.makeCtx(source, request.signal);
    const interval = intervalFor(source.rateLimit);

    const available = await this.limiter.run(source.key, interval, () =>
      source.listSets!(ctx, request.game),
    );

    const wanted = request.setIds
      ? available.filter((s) => request.setIds!.includes(s.setId))
      : available;

    const maxSets = request.maxSets ?? DEFAULT_MAX_SETS;
    if (wanted.length > maxSets) {
      // Refused rather than truncated. Silently ingesting the first 50 of 453
      // would leave a catalog that looks complete and is not, which is worse
      // than a caller having to say what they meant.
      throw new BadRequestException(
        `That would ingest ${wanted.length} sets, above the limit of ${maxSets}. Narrow by game ` +
          `or set, or raise maxSets deliberately.`,
      );
    }

    const report: IngestReport = {
      sourceKey: source.key,
      sets: 0,
      products: 0,
      created: 0,
      refreshed: 0,
      unchanged: 0,
      problems: [],
      durationMs: 0,
    };

    for (const set of wanted) {
      // One bad set must not lose the rest of the run: a full-game ingest is
      // minutes of downloads, and discarding all of it because one file 404s
      // would make the feature unusable exactly when a source is flaky.
      try {
        const candidates = await this.limiter.run(source.key, interval, () =>
          source.fetchSet!(ctx, set.setId),
        );

        for (const candidate of candidates) {
          const outcome = await this.intake.ensureCatalogItem(
            { ...candidate, sourceKey: source.key },
            { refresh: true },
          );

          report.products++;
          if (outcome.createdCatalogItem) report.created++;
          else if (outcome.refreshed) report.refreshed++;
          else report.unchanged++;
        }

        report.sets++;
      } catch (error) {
        report.problems.push({
          set: `${set.name} (${set.setId})`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    report.durationMs = Date.now() - startedAt;

    this.logger.log(
      `Ingested ${report.sourceKey}: ${report.sets}/${wanted.length} sets, ${report.products} ` +
        `products (${report.created} new, ${report.refreshed} refreshed, ${report.unchanged} ` +
        `unchanged, ${report.problems.length} problem(s)) in ${Math.round(report.durationMs / 1000)}s.`,
    );

    return report;
  }

  private async makeCtx(source: CatalogSource, signal?: AbortSignal): Promise<CatalogCtx> {
    const context = `ingest:${source.key}`;
    return {
      secrets: await this.credentials.loadSecrets(source),
      ...(signal ? { signal } : {}),
      logger: {
        debug: (m) => this.logger.debug(m, context),
        info: (m) => this.logger.log(m, context),
        warn: (m) => this.logger.warn(m, context),
        error: (m) => this.logger.error(m, context),
      },
    };
  }
}
