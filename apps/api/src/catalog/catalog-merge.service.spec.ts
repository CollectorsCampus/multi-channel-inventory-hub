import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { CatalogMergeService } from './catalog-merge.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Merging duplicate catalog items, against a real database.
 *
 * Every property here is about **not destroying a ledger**. `CatalogItem`
 * cascades to `Sku` → `InventoryItem` → `StockMovement` and
 * `ChannelAllocation`, so a careless delete takes stock, live listing links and
 * the whole audit trail with it and leaves no trace that it did. None of that
 * is observable without the rows, which is why these are integration tests.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: CatalogMergeService;

async function seedItem(
  name: string,
  refs: Array<[string, string]>,
  skus: Array<{ condition: string; printing?: string; language?: string }> = [],
) {
  return prisma.catalogItem.create({
    data: {
      name,
      searchName: name.toLowerCase(),
      game: 'Test',
      externalRefs: { create: refs.map(([source, externalId]) => ({ source, externalId })) },
      skus: {
        create: skus.map((s) => ({
          condition: s.condition,
          printing: s.printing ?? 'NORMAL',
          language: s.language ?? 'EN',
        })),
      },
    },
    include: { skus: true },
  });
}

async function stock(skuId: string, quantityOnHand = 0, reserveQuantity = 0) {
  return prisma.inventoryItem.create({ data: { skuId, quantityOnHand, reserveQuantity } });
}

describeDb('CatalogMergeService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new CatalogMergeService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.channelInstance.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  it('moves the ids and the SKUs, and deletes the duplicate', async () => {
    const winner = await seedItem('Charizard', [['tcgplayer', '111']], [{ condition: 'NM' }]);
    const loser = await seedItem('Charizard', [['cardtrader', 'bp-9']], [{ condition: 'LP' }]);
    const lpInventory = await stock(loser.skus[0]!.id, 3);

    const report = await service.merge(winner.id, loser.id);

    expect(report).toMatchObject({ movedSkus: 1, discardedSkus: 0 });
    expect(report.movedRefs).toEqual([{ source: 'cardtrader', externalId: 'bp-9' }]);

    // The winner now answers to both id spaces, which is the whole point.
    const refs = await prisma.catalogExternalRef.findMany({
      where: { catalogItemId: winner.id },
      select: { source: true },
    });
    expect(refs.map((r) => r.source).sort()).toEqual(['cardtrader', 'tcgplayer']);

    // And the stock came with it rather than being cascaded away.
    expect(await prisma.catalogItem.findUnique({ where: { id: loser.id } })).toBeNull();
    const moved = await prisma.inventoryItem.findUnique({ where: { id: lpInventory.id } });
    expect(moved?.quantityOnHand).toBe(3);
    expect(await prisma.sku.count({ where: { catalogItemId: winner.id } })).toBe(2);
  });

  /**
   * The realistic duplicate: an ingest created a catalog row and nobody ever
   * took stock against it. Nothing of value to preserve, so it simply goes.
   */
  it('discards an empty duplicate SKU the winner already has', async () => {
    const winner = await seedItem('Pikachu', [['tcgplayer', '222']], [{ condition: 'NM' }]);
    const loser = await seedItem('Pikachu', [['cardtrader', 'bp-1']], [{ condition: 'NM' }]);

    const report = await service.merge(winner.id, loser.id);

    expect(report).toMatchObject({ movedSkus: 0, discardedSkus: 1 });
    expect(await prisma.sku.count({ where: { catalogItemId: winner.id } })).toBe(1);
  });

  /**
   * The refusals. Each of these would otherwise be a silent cascade delete of
   * something the ledger promises to keep, and each names the row so the
   * operator can act rather than guess.
   */
  describe('refuses rather than destroying a ledger', () => {
    it('refuses when the duplicate SKU holds stock', async () => {
      const winner = await seedItem('Mewtwo', [['tcgplayer', '333']], [{ condition: 'NM' }]);
      const loser = await seedItem('Mewtwo', [['cardtrader', 'bp-2']], [{ condition: 'NM' }]);
      await stock(loser.skus[0]!.id, 5);

      await expect(service.merge(winner.id, loser.id)).rejects.toThrow(/cannot be merged/i);

      // Refused before writing: both items, and the stock, are untouched.
      expect(await prisma.catalogItem.count()).toBe(2);
      expect(await prisma.inventoryItem.count()).toBe(1);
      const refs = await prisma.catalogExternalRef.findMany({
        where: { catalogItemId: loser.id },
      });
      expect(refs).toHaveLength(1);
    });

    it('refuses when it is reserved but not on hand', async () => {
      const winner = await seedItem('Snorlax', [['tcgplayer', '444']], [{ condition: 'NM' }]);
      const loser = await seedItem('Snorlax', [['cardtrader', 'bp-3']], [{ condition: 'NM' }]);
      await stock(loser.skus[0]!.id, 0, 2);

      await expect(service.merge(winner.id, loser.id)).rejects.toThrow(/cannot be merged/i);
    });

    it('refuses when the duplicate is on a channel, even with no stock', async () => {
      const winner = await seedItem('Eevee', [['tcgplayer', '555']], [{ condition: 'NM' }]);
      const loser = await seedItem('Eevee', [['cardtrader', 'bp-4']], [{ condition: 'NM' }]);
      const inventory = await stock(loser.skus[0]!.id, 0);
      const channel = await prisma.channelInstance.create({
        data: { connectorKey: 'test', displayName: 'Somewhere', config: '{}' },
      });
      await prisma.channelAllocation.create({
        data: { inventoryItemId: inventory.id, channelInstanceId: channel.id },
      });

      await expect(service.merge(winner.id, loser.id)).rejects.toThrow(/cannot be merged/i);
    });

    /**
     * A history with no stock still records that something happened here.
     * Deleting it would quietly remove an audit trail, which is the one thing
     * `StockMovement` exists to guarantee.
     */
    it('refuses when the duplicate has stock movements but no stock', async () => {
      const winner = await seedItem('Gengar', [['tcgplayer', '666']], [{ condition: 'NM' }]);
      const loser = await seedItem('Gengar', [['cardtrader', 'bp-5']], [{ condition: 'NM' }]);
      const inventory = await stock(loser.skus[0]!.id, 0);
      await prisma.stockMovement.create({
        data: {
          inventoryItemId: inventory.id,
          delta: 1,
          resultingOnHand: 1,
          reason: 'intake',
        },
      });

      await expect(service.merge(winner.id, loser.id)).rejects.toThrow(/cannot be merged/i);
    });

    it('names the offending SKUs so they can be dealt with', async () => {
      const winner = await seedItem('Zapdos', [['tcgplayer', '777']], [{ condition: 'NM' }]);
      const loser = await seedItem('Zapdos', [['cardtrader', 'bp-6']], [{ condition: 'NM' }]);
      await stock(loser.skus[0]!.id, 4);

      await expect(service.merge(winner.id, loser.id)).rejects.toMatchObject({
        response: {
          blockers: [{ skuId: loser.skus[0]!.id, condition: 'NM', reason: /4 on hand/ }],
        },
      });
    });
  });

  it('refuses to merge an item into itself', async () => {
    const item = await seedItem('Ditto', [['tcgplayer', '888']]);
    await expect(service.merge(item.id, item.id)).rejects.toThrow(/into itself/i);
  });

  it('reports a missing item rather than half-merging', async () => {
    const item = await seedItem('Abra', [['tcgplayer', '999']]);
    await expect(service.merge(item.id, 'nope')).rejects.toThrow(/not found/i);
    await expect(service.merge('nope', item.id)).rejects.toThrow(/not found/i);
    expect(await prisma.catalogItem.count()).toBe(1);
  });
});
