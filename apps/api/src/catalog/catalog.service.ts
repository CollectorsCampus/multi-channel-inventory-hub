import { Injectable, Logger } from '@nestjs/common';
import type {
  CatalogCandidate,
  CatalogCtx,
  CatalogSearchQuery,
  CatalogSource,
} from '@hub/connector-sdk';
import { CatalogSourceRegistry, type AttributedCandidate } from './catalog-source-registry.service';
import { MinIntervalLimiter, intervalFor } from './rate-limiter';

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

  constructor(private readonly registry: CatalogSourceRegistry) {}

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
