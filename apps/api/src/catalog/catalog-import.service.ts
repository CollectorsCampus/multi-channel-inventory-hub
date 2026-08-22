import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IntakeService } from '../inventory/intake.service';
import { isValidSourceId } from '../inventory/sku-code';
import { IMPORTED_SOURCE_KEY } from './imported-source';

/**
 * Loading a hand-built card list into the local catalog.
 *
 * The counterpart of `CatalogIngestService` for games no source publishes:
 * the operator supplies the rows — scraped, typed, exported from wherever —
 * and they land as ordinary `CatalogItem`s carrying an `imported` external
 * ref, which is what makes them searchable, intakeable and listable through
 * the `imported` source with no special cases downstream.
 *
 * ## The id scheme
 *
 * A ref is `imported:<namespace>.<id>` — namespace `neuroscape`, id `GEN-1`,
 * external id `neuroscape.GEN-1`. The namespace keeps two imported games'
 * ids from colliding, and the dot is unambiguous because a namespace may not
 * contain one. The combined id must satisfy the SKU code's `sourceId` shape
 * (`isValidSourceId` — the same test, imported, so the two cannot drift):
 * these ids end up encoded into listing SKUs on a live storefront, and an id
 * accepted here but refused there would surface months later as a listing
 * creation that cannot build its code.
 *
 * ## Refresh: fill-empty-only, except the image
 *
 * Re-importing goes through `ensureCatalogItem({ refresh: true })`, so names
 * and sets follow the standing fill-empty-only rule — an import cannot
 * relabel the catalogue behind the operator. The **image is the one
 * exception, overwritten when it differs**, because the use case this path
 * was built for (Neuroscape) publishes images as signed URLs that expire in
 * 24 hours: a re-import exists precisely to refresh them, and fill-empty
 * would pin the first, dead URL forever. Safe where the general overwrite
 * was not: an `imported` ref can only have been written by this service —
 * imported candidates carry no other source's namespace, so they never
 * converge onto another source's row — which means the value being replaced
 * is this same import's own earlier data, not another source's.
 */

export interface CatalogImportItem {
  /** Id unique within the namespace, e.g. a collector number. */
  id: string;
  name: string;
  setName?: string;
  collectorNumber?: string;
  imageUrl?: string;
}

export interface CatalogImportRequest {
  namespace: string;
  game: string;
  /** Default for items that do not carry their own. */
  setName?: string;
  items: CatalogImportItem[];
}

export interface CatalogImportReport {
  namespace: string;
  items: number;
  created: number;
  refreshed: number;
  /** Stored images replaced because the incoming URL differed. */
  imagesRefreshed: number;
  problems: Array<{ id: string; message: string }>;
  durationMs: number;
}

/**
 * Bounded like every other batch here, and a run over the cap is refused
 * rather than truncated — a partially imported set that looks complete is the
 * ingest `maxSets` argument again. A full set is hundreds of cards, so the
 * ceiling covers several sets in one file without inviting "the whole game".
 */
const MAX_ITEMS = 1000;

const NAMESPACE_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: IntakeService,
  ) {}

  async import(request: CatalogImportRequest): Promise<CatalogImportReport> {
    const started = Date.now();

    if (!NAMESPACE_SHAPE.test(request.namespace)) {
      throw new BadRequestException(
        `Namespace "${request.namespace}" must be lowercase alphanumeric with dashes.`,
      );
    }
    if (request.items.length === 0) {
      throw new BadRequestException('Nothing to import.');
    }
    if (request.items.length > MAX_ITEMS) {
      throw new BadRequestException(
        `Import of ${request.items.length} items exceeds the limit of ${MAX_ITEMS}. ` +
          `Split the file rather than trusting a truncated run.`,
      );
    }

    const report: CatalogImportReport = {
      namespace: request.namespace,
      items: request.items.length,
      created: 0,
      refreshed: 0,
      imagesRefreshed: 0,
      problems: [],
      durationMs: 0,
    };

    // Duplicate ids in one file are a data error the operator should hear
    // about per row, while the rest still land — the ingest convention.
    const seen = new Set<string>();

    for (const item of request.items) {
      const sourceId = `${request.namespace}.${item.id}`;

      if (!isValidSourceId(sourceId)) {
        report.problems.push({
          id: item.id,
          message: `Id "${item.id}" cannot form a valid external id ("${sourceId}").`,
        });
        continue;
      }
      if (seen.has(sourceId)) {
        report.problems.push({ id: item.id, message: `Duplicate id "${item.id}" in this file.` });
        continue;
      }
      seen.add(sourceId);
      const name = item.name.trim();
      if (name === '') {
        report.problems.push({ id: item.id, message: 'Name is empty.' });
        continue;
      }

      try {
        const setName = item.setName ?? request.setName;
        const { catalogItemId, createdCatalogItem, refreshed } =
          await this.intake.ensureCatalogItem(
            {
              sourceKey: IMPORTED_SOURCE_KEY,
              sourceId,
              name,
              game: request.game,
              externalIds: { [IMPORTED_SOURCE_KEY]: sourceId },
              ...(setName !== undefined ? { setName } : {}),
              ...(item.collectorNumber !== undefined
                ? { collectorNumber: item.collectorNumber }
                : {}),
              ...(item.imageUrl !== undefined ? { imageUrl: item.imageUrl } : {}),
            },
            { refresh: true },
          );

        if (createdCatalogItem) report.created += 1;
        else if (refreshed) report.refreshed += 1;

        // The image exception — see the header. Only ever fires on a row this
        // import already owns, and only when the URL actually changed.
        if (!createdCatalogItem && item.imageUrl !== undefined) {
          const stored = await this.prisma.catalogItem.findUniqueOrThrow({
            where: { id: catalogItemId },
            select: { imageUrl: true },
          });
          if (stored.imageUrl !== item.imageUrl) {
            await this.prisma.catalogItem.update({
              where: { id: catalogItemId },
              data: { imageUrl: item.imageUrl },
            });
            report.imagesRefreshed += 1;
          }
        }
      } catch (error) {
        report.problems.push({
          id: item.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    report.durationMs = Date.now() - started;
    this.logger.log(
      `Imported ${report.items} item(s) into "${request.namespace}": ` +
        `${report.created} created, ${report.refreshed} refreshed, ` +
        `${report.imagesRefreshed} image(s) refreshed, ${report.problems.length} problem(s).`,
    );
    return report;
  }
}
