import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { CatalogCandidate } from '@hub/connector-sdk';
import { IntakeService } from './intake.service';
import { InventoryService } from './inventory.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Intake against a real database.
 *
 * The behaviour worth testing is all find-or-create: buying the same card twice
 * must add to the existing SKU rather than fail on the natural key or split the
 * ledger across two rows that each look right in isolation. None of that is
 * observable without a database enforcing the constraints.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const BOLT: CatalogCandidate & { sourceKey: string } = {
  sourceKey: 'scryfall',
  sourceId: 'sf-bolt',
  name: 'Lightning Bolt',
  game: 'Magic',
  setName: 'Masters 25',
  imageUrl: 'https://example.test/bolt.jpg',
  externalIds: { scryfall: 'sf-bolt', tcgplayer: '697344' },
  marketPrice: 249,
  language: 'EN',
};

/** No tcgplayer id — the ADR 0002 case. */
const LOTUS: CatalogCandidate & { sourceKey: string } = {
  sourceKey: 'scryfall',
  sourceId: 'sf-lotus',
  name: 'Black Lotus',
  game: 'Magic',
  setName: 'Alpha',
  externalIds: { scryfall: 'sf-lotus' },
};

let prisma: PrismaClient;
let intake: IntakeService;
let fetchCandidate: ReturnType<typeof vi.fn>;

describeDb('IntakeService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();

    fetchCandidate = vi.fn(async (_sourceKey: string, sourceId: string) => {
      if (sourceId === BOLT.sourceId) return BOLT;
      if (sourceId === LOTUS.sourceId) return LOTUS;
      return null;
    });

    const catalog = { fetchCandidate } as unknown as CatalogService;
    const inventory = new InventoryService(prisma as unknown as PrismaService);
    intake = new IntakeService(prisma as unknown as PrismaService, catalog, inventory);
  });

  const bolt = (overrides: Partial<Parameters<IntakeService['intake']>[0]> = {}) =>
    intake.intake({
      sourceKey: 'scryfall',
      sourceId: 'sf-bolt',
      condition: 'NM',
      quantity: 3,
      ...overrides,
    });

  it('creates catalog item, SKU and unallocated stock', async () => {
    const result = await bolt();

    expect(result.createdCatalogItem).toBe(true);
    expect(result.createdSku).toBe(true);
    expect(result.ledger.quantityOnHand).toBe(3);
    // Recording that stock exists is separate from deciding where it goes.
    expect(result.ledger.allocations).toEqual([]);
    expect(result.ledger.pool).toBe(3);

    const item = await prisma.catalogItem.findUniqueOrThrow({
      where: { id: result.catalogItemId },
      include: { externalRefs: true },
    });
    expect(item.name).toBe('Lightning Bolt');
    expect(item.searchName).toBe('lightning bolt');
    expect(item.setName).toBe('Masters 25');
  });

  /**
   * §4 keys the catalog on canonical platform ids. Every id the source supplied
   * is recorded, not just the one searched by — the TCGPlayer id is how a
   * TCGPlayer listing will later be matched.
   */
  it('records every external id the source supplied', async () => {
    const result = await bolt();

    const refs = await prisma.catalogExternalRef.findMany({
      where: { catalogItemId: result.catalogItemId },
      orderBy: { source: 'asc' },
    });

    expect(refs.map((r) => [r.source, r.externalId])).toEqual([
      ['scryfall', 'sf-bolt'],
      ['tcgplayer', '697344'],
    ]);
  });

  it('records only the ids that exist, without inventing a blank', async () => {
    const result = await intake.intake({
      sourceKey: 'scryfall',
      sourceId: 'sf-lotus',
      condition: 'LP',
      quantity: 1,
    });

    const refs = await prisma.catalogExternalRef.findMany({
      where: { catalogItemId: result.catalogItemId },
    });
    expect(refs.map((r) => r.source)).toEqual(['scryfall']);
  });

  it('records a stock movement', async () => {
    const result = await bolt();
    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { inventoryItemId: result.ledger.inventoryItemId },
    });

    expect(movement.delta).toBe(3);
    expect(movement.reason).toBe('intake');
    expect(movement.resultingOnHand).toBe(3);
  });

  describe('repeat intake', () => {
    it('adds to existing stock rather than creating a second SKU', async () => {
      const first = await bolt({ quantity: 3 });
      const second = await bolt({ quantity: 2 });

      expect(second.createdCatalogItem).toBe(false);
      expect(second.createdSku).toBe(false);
      expect(second.skuId).toBe(first.skuId);
      expect(second.ledger.quantityOnHand).toBe(5);

      expect(await prisma.sku.count()).toBe(1);
      expect(await prisma.catalogItem.count()).toBe(1);
      // Both intakes are in the ledger, so on-hand stays reconstructible.
      expect(await prisma.stockMovement.count()).toBe(2);
    });

    it('separates conditions into distinct SKUs under one catalog item', async () => {
      const nm = await bolt({ condition: 'NM', quantity: 3 });
      const lp = await bolt({ condition: 'LP', quantity: 1 });

      expect(lp.catalogItemId).toBe(nm.catalogItemId);
      expect(lp.skuId).not.toBe(nm.skuId);
      expect(await prisma.catalogItem.count()).toBe(1);
      expect(await prisma.sku.count()).toBe(2);
    });

    it('separates printings, so a foil is not merged with a non-foil', async () => {
      const normal = await bolt({ printing: 'NORMAL' });
      const foil = await bolt({ printing: 'FOIL' });

      expect(foil.skuId).not.toBe(normal.skuId);
      expect(await prisma.sku.count()).toBe(2);
    });

    it('treats printing and language case-insensitively', async () => {
      const first = await bolt({ printing: 'foil', language: 'en' });
      const second = await bolt({ printing: 'FOIL', language: 'EN' });

      // Otherwise "foil" and "FOIL" become two SKUs holding the same card.
      expect(second.skuId).toBe(first.skuId);
      expect(await prisma.sku.count()).toBe(1);
    });
  });

  /**
   * Matching is by external reference, never by name — two printings can share
   * a name, and a renamed product must still resolve to the same item.
   */
  it('reuses a catalog item matched on any known external id', async () => {
    const first = await bolt();

    // A different source id, but the same TCGPlayer id as the existing item.
    fetchCandidate.mockResolvedValueOnce({
      sourceKey: 'other',
      sourceId: 'other-1',
      name: 'Lightning Bolt (renamed)',
      externalIds: { other: 'other-1', tcgplayer: '697344' },
    });

    const second = await intake.intake({
      sourceKey: 'other',
      sourceId: 'other-1',
      condition: 'MP',
      quantity: 1,
    });

    expect(second.catalogItemId).toBe(first.catalogItemId);
    expect(second.createdCatalogItem).toBe(false);
  });

  it('backfills an id the catalog item did not have before', async () => {
    fetchCandidate.mockResolvedValueOnce({ ...BOLT, externalIds: { scryfall: 'sf-bolt' } });
    const first = await bolt();

    let refs = await prisma.catalogExternalRef.findMany({
      where: { catalogItemId: first.catalogItemId },
    });
    expect(refs).toHaveLength(1);

    // The source has since started publishing a TCGPlayer id.
    await bolt({ quantity: 1 });

    refs = await prisma.catalogExternalRef.findMany({
      where: { catalogItemId: first.catalogItemId },
      orderBy: { source: 'asc' },
    });
    expect(refs.map((r) => r.source)).toEqual(['scryfall', 'tcgplayer']);
  });

  describe('rejections', () => {
    it('refuses a product the source does not know', async () => {
      await expect(
        intake.intake({ sourceKey: 'scryfall', sourceId: 'nope', condition: 'NM', quantity: 1 }),
      ).rejects.toThrow(/has no product/);
    });

    it('refuses a non-positive quantity', async () => {
      await expect(bolt({ quantity: 0 })).rejects.toThrow(/positive whole number/);
      await expect(bolt({ quantity: -1 })).rejects.toThrow(/positive whole number/);
      await expect(bolt({ quantity: 1.5 })).rejects.toThrow(/positive whole number/);
    });

    /**
     * The client sends only a source and an id. Anything it claimed about the
     * product would otherwise be written into CatalogExternalRef, which every
     * future listing is keyed on.
     */
    it('takes product details from the source, never from the caller', async () => {
      const result = await bolt();

      expect(fetchCandidate).toHaveBeenCalledWith('scryfall', 'sf-bolt');
      const item = await prisma.catalogItem.findUniqueOrThrow({
        where: { id: result.catalogItemId },
      });
      expect(item.name).toBe('Lightning Bolt');
    });
  });
});
