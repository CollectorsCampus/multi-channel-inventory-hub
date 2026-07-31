import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { CatalogCandidate } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { InventoryService, type LedgerSnapshot } from './inventory.service';

/**
 * Intake: catalog result → stock on the shelf (§7).
 *
 * Lands as **unallocated** stock. Intake never touches allocations — deciding
 * where stock goes is a separate act from recording that it exists, and
 * conflating them would put allocation rules in two places.
 *
 * Everything here is find-or-create. Buying the same card twice must add to the
 * existing SKU rather than fail on the natural-key constraint or, worse, split
 * the ledger across two rows that each look correct in isolation.
 */

export interface IntakeRequest {
  sourceKey: string;
  sourceId: string;
  condition: string;
  printing?: string;
  language?: string;
  quantity: number;
  costBasis?: number;
  actorUserId?: string;
}

export interface IntakeResult {
  ledger: LedgerSnapshot;
  catalogItemId: string;
  skuId: string;
  /** True when this intake created the catalog entry rather than reusing one. */
  createdCatalogItem: boolean;
  /** True when this intake created the SKU rather than adding to an existing one. */
  createdSku: boolean;
  /** Platform ids recorded against the catalog item. */
  externalIds: Record<string, string>;
}

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly inventory: InventoryService,
  ) {}

  async intake(request: IntakeRequest): Promise<IntakeResult> {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new BadRequestException('Intake quantity must be a positive whole number.');
    }

    // Re-fetched from the source, never taken from the request body. See
    // CatalogService.fetchCandidate.
    const candidate = await this.catalog.fetchCandidate(request.sourceKey, request.sourceId);
    if (!candidate) {
      throw new BadRequestException(
        `Catalog source "${request.sourceKey}" has no product "${request.sourceId}".`,
      );
    }

    const printing = normalize(request.printing) ?? 'NORMAL';
    const language = normalize(request.language) ?? normalize(candidate.language) ?? 'EN';

    const { catalogItemId, createdCatalogItem } = await this.resolveCatalogItem(candidate);

    const existingSku = await this.prisma.sku.findUnique({
      where: {
        catalogItemId_condition_printing_language: {
          catalogItemId,
          condition: request.condition,
          printing,
          language,
        },
      },
      include: { inventory: true },
    });

    if (existingSku?.inventory) {
      // Adding to stock we already hold. Goes through InventoryService so the
      // stock movement is recorded and the invariant is revalidated.
      const { ledger } = await this.inventory.adjustQuantityOnHand(
        existingSku.inventory.id,
        request.quantity,
        { reason: 'intake', actorUserId: request.actorUserId },
      );

      return {
        ledger,
        catalogItemId,
        skuId: existingSku.id,
        createdCatalogItem,
        createdSku: false,
        externalIds: { ...candidate.externalIds },
      };
    }

    const sku =
      existingSku ??
      (await this.prisma.sku.create({
        data: { catalogItemId, condition: request.condition, printing, language },
      }));

    // A SKU with no inventory row is possible if a previous intake failed
    // between the two writes; creating the missing row is the right recovery.
    const item = await this.prisma.inventoryItem.create({
      data: {
        skuId: sku.id,
        quantityOnHand: request.quantity,
        costBasis: request.costBasis ?? null,
      },
    });

    await this.prisma.stockMovement.create({
      data: {
        inventoryItemId: item.id,
        delta: request.quantity,
        resultingOnHand: request.quantity,
        reason: 'intake',
        note: `${candidate.sourceKey}:${candidate.sourceId}`,
        actorUserId: request.actorUserId ?? null,
      },
    });

    return {
      ledger: await this.inventory.getLedger(item.id),
      catalogItemId,
      skuId: sku.id,
      createdCatalogItem,
      createdSku: true,
      externalIds: { ...candidate.externalIds },
    };
  }

  /**
   * Make sure a SKU and its inventory row exist, without receiving any stock.
   *
   * For linking an existing channel listing to the ledger. `intake` cannot serve
   * that: it requires a positive quantity, because receiving zero units is not a
   * thing anyone means to do. Linking, on the other hand, is *only* about
   * identity — the operator already holds whatever they hold, and inventing a
   * quantity here would credit them stock they never counted.
   *
   * No `StockMovement` either, for the same reason: nothing moved. A movement row
   * with delta 0 would be a lie in the audit trail.
   *
   * Lives here rather than in the matching service so that catalog-item
   * resolution, SKU creation and inventory-row creation keep one owner.
   */
  async ensureSku(
    candidate: CatalogCandidate & { sourceKey: string },
    dimensions: { condition: string; printing?: string; language?: string },
  ): Promise<{
    inventoryItemId: string;
    skuId: string;
    catalogItemId: string;
    createdCatalogItem: boolean;
    createdSku: boolean;
    externalIds: Record<string, string>;
    /**
     * The dimensions actually stored, which are not always the ones asked for:
     * `printing` falls back to `NORMAL` and `language` to the *candidate's*
     * language before `EN`. A caller that re-derived these from its own request
     * would disagree with the row whenever the catalogue supplied the language —
     * and one of those callers stamps the result onto a live storefront.
     */
    condition: string;
    printing: string;
    language: string;
  }> {
    const printing = normalize(dimensions.printing) ?? 'NORMAL';
    const language = normalize(dimensions.language) ?? normalize(candidate.language) ?? 'EN';

    const { catalogItemId, createdCatalogItem } = await this.resolveCatalogItem(candidate);

    const existingSku = await this.prisma.sku.findUnique({
      where: {
        catalogItemId_condition_printing_language: {
          catalogItemId,
          condition: dimensions.condition,
          printing,
          language,
        },
      },
      include: { inventory: true },
    });

    // Already there, stock and all. Returning it unchanged is what makes
    // confirming the same link twice a no-op instead of a duplicate.
    if (existingSku?.inventory) {
      return {
        inventoryItemId: existingSku.inventory.id,
        skuId: existingSku.id,
        catalogItemId,
        createdCatalogItem,
        createdSku: false,
        externalIds: { ...candidate.externalIds },
        condition: existingSku.condition,
        printing: existingSku.printing,
        language: existingSku.language,
      };
    }

    const sku =
      existingSku ??
      (await this.prisma.sku.create({
        data: { catalogItemId, condition: dimensions.condition, printing, language },
      }));

    const item = await this.prisma.inventoryItem.create({
      data: { skuId: sku.id, quantityOnHand: 0 },
    });

    this.logger.log(
      `Linked SKU ${sku.id} (${candidate.name}) with no stock, from ` +
        `${candidate.sourceKey}:${candidate.sourceId}.`,
    );

    return {
      inventoryItemId: item.id,
      skuId: sku.id,
      catalogItemId,
      createdCatalogItem,
      createdSku: existingSku === null,
      externalIds: { ...candidate.externalIds },
      condition: sku.condition,
      printing: sku.printing,
      language: sku.language,
    };
  }

  /**
   * Resolve a candidate to a catalog item, for callers outside intake.
   *
   * Public so that `CatalogIngestService` can fill the catalog without a second
   * implementation of the rules below. Catalog-item creation stays owned here
   * for the same reason quantity mutations are owned by `InventoryService`: two
   * writers would eventually disagree about when a product is "the same one",
   * and that disagreement shows up as duplicate items nobody can merge.
   *
   * `refresh` is the one thing ingest needs and intake must not do. A bulk
   * ingest is re-reading the authoritative source, so refreshing a name, set or
   * image is the point of running it; an intake is one operator adding stock and
   * has no business rewriting an item's identity as a side effect.
   */
  async ensureCatalogItem(
    candidate: CatalogCandidate & { sourceKey: string },
    options: { refresh?: boolean } = {},
  ): Promise<{ catalogItemId: string; createdCatalogItem: boolean; refreshed: boolean }> {
    const { catalogItemId, createdCatalogItem } = await this.resolveCatalogItem(candidate);

    let refreshed = false;
    if (options.refresh === true && !createdCatalogItem) {
      refreshed = await this.refreshCatalogItem(catalogItemId, candidate);
    }

    return { catalogItemId, createdCatalogItem, refreshed };
  }

  /**
   * Bring a stored item's descriptive fields back in line with the source.
   *
   * Only writes when something actually differs, so re-ingesting an unchanged
   * set does not bump `updatedAt` on tens of thousands of rows and make the
   * table look churned when nothing happened.
   *
   * Deliberately does **not** touch external refs — `resolveCatalogItem` has
   * already backfilled those, and removing one is never right: an id that used
   * to point here still does, whatever the source says today.
   */
  private async refreshCatalogItem(
    catalogItemId: string,
    candidate: CatalogCandidate,
  ): Promise<boolean> {
    const current = await this.prisma.catalogItem.findUnique({
      where: { id: catalogItemId },
      select: { name: true, game: true, setName: true, imageUrl: true },
    });
    if (!current) return false;

    const name = candidate.name.trim();
    const next = {
      name,
      searchName: name.toLowerCase(),
      game: candidate.game ?? null,
      setName: candidate.setName ?? null,
      imageUrl: candidate.imageUrl ?? null,
    };

    const unchanged =
      current.name === next.name &&
      current.game === next.game &&
      current.setName === next.setName &&
      current.imageUrl === next.imageUrl;
    if (unchanged) return false;

    await this.prisma.catalogItem.update({ where: { id: catalogItemId }, data: next });
    return true;
  }

  /**
   * Find the catalog item this candidate refers to, or create it.
   *
   * Matching is by external reference, never by name. §4 keys the catalog on
   * canonical platform ids precisely so that two printings sharing a name stay
   * distinct, and so a renamed product still resolves to the same item.
   *
   * Any id the source supplied is recorded, not just the one searched by — a
   * Scryfall result carrying a TCGPlayer id is how a listing on TCGPlayer will
   * later be matched, and discarding it would mean re-fetching to get it back.
   */
  private async resolveCatalogItem(
    candidate: CatalogCandidate & { sourceKey: string },
  ): Promise<{ catalogItemId: string; createdCatalogItem: boolean }> {
    const refs = Object.entries(candidate.externalIds).filter(([, id]) => id);

    const existing = await this.prisma.catalogExternalRef.findFirst({
      where: { OR: refs.map(([source, externalId]) => ({ source, externalId })) },
    });

    if (existing) {
      // Backfill ids this item did not have before. A source that has started
      // publishing a TCGPlayer id should not require re-importing the card.
      await this.addMissingRefs(existing.catalogItemId, refs);
      return { catalogItemId: existing.catalogItemId, createdCatalogItem: false };
    }

    const name = candidate.name.trim();
    const created = await this.prisma.catalogItem.create({
      data: {
        name,
        searchName: name.toLowerCase(),
        game: candidate.game ?? null,
        setName: candidate.setName ?? null,
        imageUrl: candidate.imageUrl ?? null,
        externalRefs: {
          create: refs.map(([source, externalId]) => ({ source, externalId })),
        },
      },
    });

    return { catalogItemId: created.id, createdCatalogItem: true };
  }

  private async addMissingRefs(catalogItemId: string, refs: Array<[string, string]>) {
    for (const [source, externalId] of refs) {
      try {
        // The unique index on (source, externalId) is the real guard; a
        // concurrent intake losing this race is harmless and ignorable.
        await this.prisma.catalogExternalRef.create({
          data: { catalogItemId, source, externalId },
        });
      } catch {
        // Already present, or claimed by another catalog item. Neither is worth
        // failing an intake over, but the second case means two items disagree
        // about which product an id refers to, which someone should eventually
        // look at.
        this.logger.debug(`Could not add external ref ${source}:${externalId} to ${catalogItemId}`);
      }
    }
  }
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}
