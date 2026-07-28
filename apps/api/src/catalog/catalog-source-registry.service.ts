import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  assertValidCatalogSource,
  providesExternalId,
  type CatalogCandidate,
  type CatalogCtx,
  type CatalogSearchQuery,
  type CatalogSource,
} from '@hub/connector-sdk';
import { createScryfallSource } from '@hub/catalog-scryfall';
import { MinIntervalLimiter, intervalFor } from './rate-limiter';

/**
 * Registry of product-reference sources, parallel to ConnectorRegistry but
 * deliberately separate (see CatalogSource in the SDK).
 *
 * Also fans a search out across sources, which is the reason routing lives here
 * rather than in the intake flow: which sources can answer a query depends on
 * the game, and the intake UI should not need to know that.
 */

export interface CatalogSourceSummary {
  key: string;
  displayName: string;
  description?: string;
  games: readonly string[];
  providesExternalIds: readonly string[];
}

/** A candidate plus which source produced it. */
export interface AttributedCandidate extends CatalogCandidate {
  sourceKey: string;
}

@Injectable()
export class CatalogSourceRegistry implements OnModuleInit {
  private readonly logger = new Logger(CatalogSourceRegistry.name);
  private readonly sources = new Map<string, CatalogSource>();
  private readonly limiter = new MinIntervalLimiter();

  onModuleInit(): void {
    for (const source of BUNDLED_CATALOG_SOURCES) {
      this.register(source);
    }
    this.logger.log(
      this.sources.size === 0
        ? 'No catalog sources registered yet'
        : `Registered catalog source(s): ${[...this.sources.keys()].join(', ')}`,
    );
  }

  register(source: CatalogSource): void {
    assertValidCatalogSource(source);

    if (this.sources.has(source.key)) {
      throw new Error(
        `Two catalog sources both claim the key "${source.key}". Keys are persisted as ` +
          `CatalogExternalRef.source, so they must be unique.`,
      );
    }

    this.sources.set(source.key, source);
  }

  get(key: string): CatalogSource {
    const source = this.sources.get(key);
    if (!source) {
      const known = [...this.sources.keys()];
      throw new NotFoundException(
        `No catalog source registered for "${key}". Registered: ${known.length ? known.join(', ') : 'none'}.`,
      );
    }
    return source;
  }

  has(key: string): boolean {
    return this.sources.has(key);
  }

  list(): CatalogSourceSummary[] {
    return [...this.sources.values()].map((s) => ({
      key: s.key,
      displayName: s.displayName,
      description: s.description,
      games: s.games,
      providesExternalIds: s.providesExternalIds ?? [],
    }));
  }

  /**
   * Sources that can answer for a game.
   *
   * A source declaring no games is consulted for everything — that is the
   * documented meaning of an empty list, and it keeps single-game sources from
   * having to enumerate what they are not.
   */
  sourcesForGame(game?: string): CatalogSource[] {
    return [...this.sources.values()].filter(
      (s) => s.games.length === 0 || !game || s.games.includes(game),
    );
  }

  /** Sources that can supply ids in a namespace, e.g. which ones yield TCGPlayer ids. */
  sourcesProviding(namespace: string): CatalogSource[] {
    return [...this.sources.values()].filter((s) => providesExternalId(s, namespace));
  }

  /**
   * Search every source that can answer, and merge the results.
   *
   * One failing source must not fail the whole search: catalog sources are
   * third-party services outside our control, and an operator mid-intake should
   * still see results from the sources that did answer. Failures are logged and
   * returned alongside the results so the UI can say so.
   */
  async search(
    makeCtx: (source: CatalogSource) => CatalogCtx,
    query: CatalogSearchQuery,
  ): Promise<{
    candidates: AttributedCandidate[];
    failures: Array<{ sourceKey: string; message: string }>;
  }> {
    const applicable = this.sourcesForGame(query.game);

    const settled = await Promise.allSettled(
      applicable.map(async (source) => ({
        source,
        // Declared limits are enforced here rather than inside sources, so
        // every plugin is throttled identically and none can forget to be.
        results: await this.limiter.run(source.key, intervalFor(source.rateLimit), () =>
          source.search(makeCtx(source), query),
        ),
      })),
    );

    const candidates: AttributedCandidate[] = [];
    const failures: Array<{ sourceKey: string; message: string }> = [];

    settled.forEach((outcome, index) => {
      const source = applicable[index]!;
      if (outcome.status === 'fulfilled') {
        for (const candidate of outcome.value.results) {
          candidates.push({ ...candidate, sourceKey: source.key });
        }
      } else {
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        this.logger.warn(`Catalog source "${source.key}" failed: ${message}`);
        failures.push({ sourceKey: source.key, message });
      }
    });

    return { candidates, failures };
  }

  /** Test seam. */
  clear(): void {
    this.sources.clear();
  }
}

/**
 * Bundled catalog sources.
 *
 * tcgcsv is deliberately absent: ADR 0002 records it as an unofficial
 * redistribution of someone else's API output, fine as an opt-in importer but
 * not something to enable for every self-hoster by default.
 */
const BUNDLED_CATALOG_SOURCES: CatalogSource[] = [createScryfallSource()];
