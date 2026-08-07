import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { InventoryService } from './inventory.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Integration tests against a real database.
 *
 * The allocation maths is covered exhaustively by allocation.spec.ts without
 * any I/O. What cannot be tested there — and is the entire reason this service
 * exists — is that concurrent writers cannot both claim the same unit. Proving
 * that needs a real transactional store: the optimistic-locking retry only has
 * meaning when two connections genuinely race (ADR 0001 §1).
 *
 * Skipped when TEST_DATABASE_URL is unset so `pnpm test` stays runnable with no
 * services up. CI always sets it, so the coverage is never silently lost.
 *
 * Deliberately NOT falling back to DATABASE_URL: test/setup-env.ts always
 * defines that one so the Nest config validator passes, and it points at a
 * database that need not exist. Falling back would turn "no test database" into
 * a connection failure instead of a skip.
 *
 * These tests truncate every table they touch, so TEST_DATABASE_URL must never
 * point at a database anyone cares about.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: InventoryService;

async function seedItem(quantityOnHand: number, reserveQuantity = 0) {
  const item = await prisma.catalogItem.create({
    data: {
      name: `Test Item ${Math.random().toString(36).slice(2, 10)}`,
      game: 'Test',
      skus: { create: [{ condition: 'NM', printing: 'NORMAL', language: 'EN' }] },
    },
    include: { skus: true },
  });
  const sku = item.skus[0]!;
  return prisma.inventoryItem.create({
    data: { skuId: sku.id, quantityOnHand, reserveQuantity },
  });
}

async function seedChannel(displayName: string) {
  return prisma.channelInstance.create({
    data: { connectorKey: 'test', displayName, config: '{}' },
  });
}

describeDb('InventoryService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new InventoryService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    // Order matters: children before parents.
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.channelInstance.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  describe('quantity adjustments', () => {
    it('records a stock movement for every change', async () => {
      const item = await seedItem(0);

      await service.adjustQuantityOnHand(item.id, 5, { reason: 'intake', note: 'box opened' });
      await service.adjustQuantityOnHand(item.id, -2, { reason: 'shrinkage' });

      const movements = await prisma.stockMovement.findMany({
        where: { inventoryItemId: item.id },
        orderBy: { createdAt: 'asc' },
      });

      expect(movements.map((m) => [m.delta, m.reason, m.resultingOnHand])).toEqual([
        [5, 'intake', 5],
        [-2, 'shrinkage', 3],
      ]);
    });

    it('refuses to remove more than is on hand', async () => {
      const item = await seedItem(3);
      await expect(
        service.adjustQuantityOnHand(item.id, -4, { reason: 'shrinkage' }),
      ).rejects.toThrow(/only 3 on hand/);

      const after = await service.getLedger(item.id);
      expect(after.quantityOnHand).toBe(3);
    });

    it('bumps the version on every successful write', async () => {
      const item = await seedItem(1);
      expect((await service.getLedger(item.id)).version).toBe(0);

      await service.adjustQuantityOnHand(item.id, 1, { reason: 'intake' });
      expect((await service.getLedger(item.id)).version).toBe(1);
    });

    it('sets an absolute count, recording the delta as a movement', async () => {
      // The reconcile "correct the ledger" path: the operator names the true
      // figure and the service records how far it moved to get there.
      const item = await seedItem(3);

      await service.setQuantityOnHand(item.id, 10, { reason: 'reconcile' });

      expect((await service.getLedger(item.id)).quantityOnHand).toBe(10);
      const movement = await prisma.stockMovement.findFirst({
        where: { inventoryItemId: item.id, reason: 'reconcile' },
      });
      expect(movement?.delta).toBe(7);
      expect(movement?.resultingOnHand).toBe(10);
    });

    it('records no movement when the absolute count is unchanged', async () => {
      const item = await seedItem(4);
      await service.setQuantityOnHand(item.id, 4, { reason: 'reconcile' });
      expect(await prisma.stockMovement.count({ where: { inventoryItemId: item.id } })).toBe(0);
    });
  });

  describe('allocations', () => {
    it('creates a fixed allocation and derives its listed quantity', async () => {
      const item = await seedItem(10);
      const channel = await seedChannel('TCGPlayer');

      const { ledger, changes } = await service.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'fixed',
        quantityAllocated: 6,
      });

      expect(ledger.pool).toBe(4);
      expect(ledger.allocations[0]?.desiredListedQuantity).toBe(6);
      expect(changes).toEqual([
        expect.objectContaining({ channelInstanceId: channel.id, from: 0, to: 6 }),
      ]);
    });

    it('mirrors the pool across pooled channels, respecting a cap', async () => {
      const item = await seedItem(10);
      const shopify = await seedChannel('Shopify');
      const tcg = await seedChannel('TCGPlayer');

      await service.upsertAllocation(item.id, {
        channelInstanceId: shopify.id,
        mode: 'pooled',
        maxQuantity: 5,
      });
      const { ledger } = await service.upsertAllocation(item.id, {
        channelInstanceId: tcg.id,
        mode: 'pooled',
        maxQuantity: null,
      });

      const byChannel = Object.fromEntries(
        ledger.allocations.map((a) => [a.channelInstanceId, a.desiredListedQuantity]),
      );
      expect(byChannel[shopify.id]).toBe(5);
      expect(byChannel[tcg.id]).toBe(10);
    });

    it('rejects an allocation that would breach the invariant, leaving the ledger untouched', async () => {
      const item = await seedItem(10, 3);
      const channel = await seedChannel('TCGPlayer');

      await expect(
        service.upsertAllocation(item.id, {
          channelInstanceId: channel.id,
          mode: 'fixed',
          quantityAllocated: 8,
        }),
      ).rejects.toThrow(/allocation invariant/);

      const after = await service.getLedger(item.id);
      expect(after.allocations).toHaveLength(0);
      expect(after.version).toBe(0);
    });

    /**
     * The preview response is only useful if the caller can match it back to
     * the row being edited. Keying it by a synthetic id shipped a UI that
     * always displayed "would list 0" while the pool figure beside it was
     * correct — the numbers were right, the lookup was not.
     */
    it('keys preview results by channelInstanceId, including for unsaved allocations', async () => {
      const item = await seedItem(10);
      const tcg = await seedChannel('TCGPlayer');
      const shopify = await seedChannel('Shopify');

      await service.upsertAllocation(item.id, {
        channelInstanceId: tcg.id,
        mode: 'fixed',
        quantityAllocated: 6,
      });

      // Existing allocations only.
      const current = await service.previewLedger(item.id, {});
      expect(Object.keys(current.listed)).toEqual([tcg.id]);
      expect(current.listed[tcg.id]).toBe(6);
      expect(current.pool).toBe(4);

      // A proposal including a channel with no allocation row yet.
      const proposed = await service.previewLedger(item.id, {
        allocations: [
          { channelInstanceId: tcg.id, mode: 'fixed', quantityAllocated: 6 },
          { channelInstanceId: shopify.id, mode: 'pooled', maxQuantity: null },
        ],
      });
      expect(proposed.listed[tcg.id]).toBe(6);
      expect(proposed.listed[shopify.id]).toBe(4);
      expect(proposed.issues).toEqual([]);
    });

    it('reports preview issues against the channel, not an internal id', async () => {
      const item = await seedItem(10);
      const tcg = await seedChannel('TCGPlayer');

      const preview = await service.previewLedger(item.id, {
        allocations: [{ channelInstanceId: tcg.id, mode: 'fixed', quantityAllocated: -1 }],
      });

      const issue = preview.issues.find((i) => i.code === 'fixed_negative_quantity');
      expect(issue?.allocationId).toBe(tcg.id);
    });

    /**
     * listedQuantity records what we believe the channel is *actually*
     * advertising, so an edit must not touch it — until a push succeeds the
     * channel still shows the old number. Writing it optimistically would make
     * reconciliation compare our guess against the channel and find no drift
     * exactly when there is some. The outbound worker sets it after a
     * successful push.
     */
    it('leaves listedQuantity alone until a push succeeds', async () => {
      const item = await seedItem(10);
      const channel = await seedChannel('Shopify');

      const { ledger } = await service.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });

      // Desired is derived immediately and drives the push...
      expect(ledger.allocations[0]?.desiredListedQuantity).toBe(10);

      // ...but the cached belief about the channel is still zero.
      const row = await prisma.channelAllocation.findFirst({ where: { inventoryItemId: item.id } });
      expect(row?.listedQuantity).toBe(0);
    });
  });

  describe('sales', () => {
    it('decrements a fixed partition and on-hand together', async () => {
      const item = await seedItem(10);
      const channel = await seedChannel('TCGPlayer');
      const { ledger } = await service.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'fixed',
        quantityAllocated: 6,
      });

      const { ledger: after } = await service.applySaleFromChannel(
        item.id,
        ledger.allocations[0]!.id,
        2,
        { orderReference: 'order-123' },
      );

      expect(after.quantityOnHand).toBe(8);
      expect(after.allocations[0]?.quantityAllocated).toBe(4);

      const movement = await prisma.stockMovement.findFirst({
        where: { inventoryItemId: item.id, reason: 'sale' },
      });
      expect(movement?.delta).toBe(-2);
      expect(movement?.note).toBe('order-123');
    });

    it('clamps an oversell to zero and reports it rather than refusing', async () => {
      const item = await seedItem(2);
      const channel = await seedChannel('Shopify');
      const { ledger } = await service.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });

      const { ledger: after, conflicts } = await service.applySaleFromChannel(
        item.id,
        ledger.allocations[0]!.id,
        5,
      );

      expect(after.quantityOnHand).toBe(0);
      expect(conflicts.map((c) => c.code)).toContain('oversell_on_hand');
    });

    it('repairs the invariant when a pooled sale strands a fixed partition', async () => {
      const item = await seedItem(10, 2);
      const tcg = await seedChannel('TCGPlayer');
      const shopify = await seedChannel('Shopify');

      await service.upsertAllocation(item.id, {
        channelInstanceId: tcg.id,
        mode: 'fixed',
        quantityAllocated: 6,
      });
      const { ledger } = await service.upsertAllocation(item.id, {
        channelInstanceId: shopify.id,
        mode: 'pooled',
        maxQuantity: null,
      });

      const shopifyAllocation = ledger.allocations.find((a) => a.channelInstanceId === shopify.id)!;
      const { ledger: after, conflicts } = await service.applySaleFromChannel(
        item.id,
        shopifyAllocation.id,
        3,
      );

      expect(after.quantityOnHand).toBe(7);
      expect(after.reserveQuantity).toBe(1); // reserve absorbed the shortfall
      expect(conflicts.map((c) => c.code)).toContain('reserve_reduced');
    });
  });

  /**
   * The reason this service exists. Without the version guard these would
   * interleave as read-read-write-write and one decrement would vanish.
   */
  describe('concurrency', () => {
    it('does not lose updates when many writers race', async () => {
      const item = await seedItem(100);

      await Promise.all(
        Array.from({ length: 20 }, () =>
          service.adjustQuantityOnHand(item.id, -1, { reason: 'sale' }),
        ),
      );

      const after = await service.getLedger(item.id);
      expect(after.quantityOnHand).toBe(80);
      expect(after.version).toBe(20);

      const movements = await prisma.stockMovement.count({ where: { inventoryItemId: item.id } });
      expect(movements).toBe(20);
    });

    it('cannot let two concurrent sales both take the last unit', async () => {
      const item = await seedItem(1);
      const a = await seedChannel('A');
      const b = await seedChannel('B');

      await service.upsertAllocation(item.id, {
        channelInstanceId: a.id,
        mode: 'pooled',
        maxQuantity: null,
      });
      const { ledger } = await service.upsertAllocation(item.id, {
        channelInstanceId: b.id,
        mode: 'pooled',
        maxQuantity: null,
      });

      // Both channels believe they hold the last copy — inherent to pooled mode.
      expect(ledger.allocations.every((x) => x.desiredListedQuantity === 1)).toBe(true);

      const results = await Promise.allSettled(
        ledger.allocations.map((allocation) =>
          service.applySaleFromChannel(item.id, allocation.id, 1),
        ),
      );

      const after = await service.getLedger(item.id);
      expect(after.quantityOnHand).toBe(0);

      // Both sales are recorded — they really happened — but exactly one is
      // flagged as an oversell for a human, rather than on-hand going to -1.
      const oversells = results
        .filter((r) => r.status === 'fulfilled')
        .flatMap(
          (r) =>
            (r as PromiseFulfilledResult<Awaited<ReturnType<typeof service.applySaleFromChannel>>>)
              .value.conflicts,
        )
        .filter((c) => c.code === 'oversell_on_hand');
      expect(oversells).toHaveLength(1);
    });
  });

  /**
   * The browse filter, which is a database question rather than a page one —
   * it narrows the whole result set, so the pagination totals must move too.
   */
  describe('in-stock filter', () => {
    it('shows only what is physically held, and counts accordingly', async () => {
      await seedItem(3);
      await seedItem(1);
      await seedItem(0);

      const all = await service.listInventory({});
      const held = await service.listInventory({ inStock: true });

      expect(all.total).toBe(3);
      expect(held.total).toBe(2);
      expect(held.items.every((row) => row.quantityOnHand > 0)).toBe(true);
    });

    /**
     * Greater than zero, not merely non-zero. Shopify reports negative
     * available quantities for oversold stock and the hub passes them through
     * — so a `!= 0` filter would put "minus five" under "in stock", which is
     * the opposite of what the operator is asking to see.
     */
    it('excludes an oversold negative quantity', async () => {
      const oversold = await seedItem(0);
      await prisma.inventoryItem.update({
        where: { id: oversold.id },
        data: { quantityOnHand: -5 },
      });
      await seedItem(2);

      const held = await service.listInventory({ inStock: true });

      expect(held.total).toBe(1);
      expect(held.items[0]!.quantityOnHand).toBe(2);
    });

    it('leaves everything visible when it is off', async () => {
      await seedItem(0);
      expect((await service.listInventory({ inStock: false })).total).toBe(1);
      expect((await service.listInventory({})).total).toBe(1);
    });

    /** Filters narrow together rather than replacing one another. */
    it('combines with the other filters', async () => {
      const stocked = await seedItem(4);
      await seedItem(0);

      const channel = await seedChannel('Somewhere');
      await service.upsertAllocation(stocked.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });

      expect((await service.listInventory({ inStock: true, unlisted: true })).total).toBe(0);
      expect(
        (await service.listInventory({ inStock: true, channelInstanceId: channel.id })).total,
      ).toBe(1);
    });
  });
});
