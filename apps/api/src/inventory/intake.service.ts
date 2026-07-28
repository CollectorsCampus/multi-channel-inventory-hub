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
