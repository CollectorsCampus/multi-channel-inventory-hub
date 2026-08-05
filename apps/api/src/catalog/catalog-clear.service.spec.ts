import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { CatalogClearService } from './catalog-clear.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Clearing catalogue identity data, against a real database.
 *
 * Every property here is about **what must never be removed**, the same
 * concern `CatalogMergeService`'s own tests exist for: `CatalogItem` cascades
 * to `Sku` → `InventoryItem` → `StockMovement` and `ChannelAllocation`, so the
 * one property worth proving is that an item with a SKU — any SKU, at any
 * quantity — never disappears, and the one without survives to be a real
 * clear rather than a no-op.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: CatalogClearService;

async function seedItem(
  name: string,
  game: string | null,
  skus: Array<{ condition: string; quantityOnHand?: number }> = [],
) {
  return prisma.catalogItem.create({
    data: {
      name,
      searchName: name.toLowerCase(),
      game,
      externalRefs: { create: [{ source: 'test', externalId: name }] },
      skus: { create: skus.map((s) => ({ condition: s.condition })) },
    },
    include: { skus: true },
  });
}

async function stock(skuId: string, quantityOnHand = 0) {
  return prisma.inventoryItem.create({ data: { skuId, quantityOnHand } });
}

describeDb('CatalogClearService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new CatalogClearService(prisma as unknown as PrismaService);
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

  it('removes an item with no SKU, and counts its external ref', async () => {
    await seedItem('Unheld Booster Box', 'Pokemon');

    const report = await service.clear();

    expect(report).toEqual({ clearable: 1, protectedCount: 0, externalRefsRemoved: 1 });
    expect(await prisma.catalogItem.count()).toBe(0);
  });

  /**
   * The one property this file exists to prove. A SKU at quantity **zero**
   * still means the card was added to the ledger, or listed, or has a
   * movement in its history — none of which this service is allowed to judge,
   * so the item is kept regardless of what its SKU currently holds.
   */
  it('never removes an item that has a SKU, even at zero stock', async () => {
    const item = await seedItem('Real Card', 'Pokemon', [{ condition: 'NM' }]);
    await stock(item.skus[0]!.id, 0);

    const report = await service.clear();

    expect(report).toEqual({ clearable: 0, protectedCount: 1, externalRefsRemoved: 0 });
    expect(await prisma.catalogItem.count()).toBe(1);
    // The SKU and its inventory row must survive too — proof the cascade was
    // never reached, not just that the count matches.
    expect(await prisma.sku.count()).toBe(1);
    expect(await prisma.inventoryItem.count()).toBe(1);
  });

  it('never removes an item holding real stock', async () => {
    const item = await seedItem('Stocked Card', 'Magic', [{ condition: 'NM' }]);
    await stock(item.skus[0]!.id, 12);

    await service.clear();

    expect(await prisma.catalogItem.findUnique({ where: { id: item.id } })).not.toBeNull();
  });

  it('clears the unheld and keeps the held, in the same run', async () => {
    const unheld = await seedItem('Unheld', 'Pokemon');
    const held = await seedItem('Held', 'Pokemon', [{ condition: 'NM' }]);
    await stock(held.skus[0]!.id, 3);

    const report = await service.clear();

    expect(report.clearable).toBe(1);
    expect(report.protectedCount).toBe(1);
    expect(await prisma.catalogItem.findUnique({ where: { id: unheld.id } })).toBeNull();
    expect(await prisma.catalogItem.findUnique({ where: { id: held.id } })).not.toBeNull();
  });

  it('scopes to one game, leaving the others untouched', async () => {
    const pokemon = await seedItem('Unheld Pokemon Box', 'Pokemon');
    const magic = await seedItem('Unheld Magic Box', 'Magic');

    const report = await service.clear({ game: 'Pokemon' });

    expect(report.clearable).toBe(1);
    expect(await prisma.catalogItem.findUnique({ where: { id: pokemon.id } })).toBeNull();
    expect(await prisma.catalogItem.findUnique({ where: { id: magic.id } })).not.toBeNull();
  });

  it('previews without deleting anything', async () => {
    await seedItem('Unheld', 'Pokemon');
    const held = await seedItem('Held', 'Pokemon', [{ condition: 'NM' }]);
    await stock(held.skus[0]!.id, 1);

    const preview = await service.preview();

    expect(preview).toEqual({ clearable: 1, protectedCount: 1 });
    expect(await prisma.catalogItem.count()).toBe(2);
  });

  it('is a no-op, not an error, when nothing is clearable', async () => {
    const held = await seedItem('Held', 'Pokemon', [{ condition: 'NM' }]);
    await stock(held.skus[0]!.id, 1);

    const report = await service.clear();

    expect(report).toEqual({ clearable: 0, protectedCount: 1, externalRefsRemoved: 0 });
    expect(await prisma.catalogItem.count()).toBe(1);
  });
});
