import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { BulkAllocateService } from './bulk-allocate.service';
import { InventoryService } from './inventory.service';
import { encodeRepricingPolicy, type RepricingPolicy } from '../pricing/repricing';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * What is worth pinning is the pricing judgement, not the plumbing: which
 * figure an allocation is created at, and — more importantly — which items this
 * refuses to price at all rather than guessing.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: BulkAllocateService;
let channelId: string;

/** NM at market, LP at 80%, and nothing declared for MP. */
const POLICY: RepricingPolicy = {
  enabled: true,
  conditionPercents: { NM: 100, LP: 80 },
};

async function seedChannel(policy: RepricingPolicy = POLICY) {
  const channel = await prisma.channelInstance.create({
    data: {
      connectorKey: 'shopify',
      displayName: 'Test Store',
      config: '{}',
      repricingPolicy: encodeRepricingPolicy(policy),
    },
  });
  return channel.id;
}

async function seedItem(options: {
  name: string;
  condition: string;
  printing?: string;
  /** Market figures to record, keyed by source. */
  prices?: Array<{ source: string; printing?: string; price: number }>;
}) {
  const catalogItem = await prisma.catalogItem.create({
    data: {
      name: options.name,
      searchName: options.name.toLowerCase(),
      skus: {
        create: [
          {
            condition: options.condition,
            printing: options.printing ?? 'NORMAL',
            language: 'EN',
          },
        ],
      },
    },
    include: { skus: true },
  });

  for (const p of options.prices ?? []) {
    await prisma.marketPrice.create({
      data: {
        catalogItemId: catalogItem.id,
        source: p.source,
        printing: p.printing ?? 'NORMAL',
        price: p.price,
        fetchedAt: new Date(),
      },
    });
  }

  const item = await prisma.inventoryItem.create({
    data: { skuId: catalogItem.skus[0]!.id, quantityOnHand: 3 },
  });
  return item.id;
}

describeDb('BulkAllocateService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new BulkAllocateService(
      prisma as unknown as PrismaService,
      new InventoryService(prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.marketPrice.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
    await prisma.channelInstance.deleteMany();
    channelId = await seedChannel();
  });

  /**
   * The distinction the whole design turns on. "Use the market price" reads as
   * the raw figure, but the policy is what the operator sells at — and writing
   * the market figure onto an LP card priced at 80% would have the next sweep
   * propose changing it the same night.
   */
  it('prices at what the policy says, not the raw market figure', async () => {
    const nm = await seedItem({
      name: 'At market',
      condition: 'NM',
      prices: [{ source: 'tcgcsv', price: 1000 }],
    });
    const lp = await seedItem({
      name: 'Played',
      condition: 'LP',
      prices: [{ source: 'tcgcsv', price: 1000 }],
    });

    const rows = await service.preview(channelId, [nm, lp]);

    expect(rows.map((r) => [r.condition, r.marketPrice, r.price])).toEqual([
      ['NM', 1000, 1000],
      // 80% of the same market figure — not 1000.
      ['LP', 1000, 800],
    ]);
  });

  /**
   * Pricing an undeclared condition at the raw market figure would be the
   * software deciding what a grade is worth, which is the one thing
   * `conditionPercents` exists to refuse.
   */
  it('refuses a condition the policy declares no percentage for', async () => {
    const mp = await seedItem({
      name: 'Moderately played',
      condition: 'MP',
      prices: [{ source: 'tcgcsv', price: 1000 }],
    });

    const [row] = await service.preview(channelId, [mp]);

    expect(row!.price).toBeNull();
    expect(row!.skipped).toMatch(/no percentage of market for MP/);
    // The figure is still reported, so the operator can see why it was skipped
    // rather than wondering whether the item has a market at all.
    expect(row!.marketPrice).toBe(1000);
  });

  it('skips an item no sweep has ever priced', async () => {
    const unpriced = await seedItem({ name: 'Never swept', condition: 'NM' });

    const [row] = await service.preview(channelId, [unpriced]);

    expect(row!.price).toBeNull();
    expect(row!.skipped).toMatch(/no market price recorded/);
  });

  /**
   * A foil priced off the plain printing's market is the wrong price with no
   * error — the reason the sweep records figures per printing at all.
   */
  it('prices from its own printing, never another', async () => {
    const foil = await seedItem({
      name: 'Foil',
      condition: 'NM',
      printing: 'FOIL',
      prices: [{ source: 'tcgcsv', printing: 'NORMAL', price: 500 }],
    });

    const [row] = await service.preview(channelId, [foil]);

    expect(row!.price).toBeNull();
    expect(row!.skipped).toMatch(/no market price recorded/);
  });

  it('prefers tcgcsv to scryfall, as the repricing sweep does', async () => {
    const item = await seedItem({
      name: 'Two sources',
      condition: 'NM',
      prices: [
        { source: 'scryfall', price: 700 },
        { source: 'tcgcsv', price: 900 },
      ],
    });

    const [row] = await service.preview(channelId, [item]);

    expect(row!.source).toBe('tcgcsv');
    expect(row!.price).toBe(900);
  });

  it('creates a pooled allocation at the previewed price', async () => {
    const item = await seedItem({
      name: 'Listable',
      condition: 'NM',
      prices: [{ source: 'tcgcsv', price: 1234 }],
    });

    const result = await service.allocate(channelId, [item]);

    expect(result.allocated).toEqual([{ inventoryItemId: item, name: 'Listable', price: 1234 }]);
    const allocation = await prisma.channelAllocation.findFirstOrThrow({
      where: { inventoryItemId: item, channelInstanceId: channelId },
    });
    expect(allocation.price).toBe(1234);
    // Pooled, not fixed: splitting stock between channels is not a decision a
    // bulk action should make.
    expect(allocation.mode).toBe('pooled');
  });

  /** Re-running must not disturb an allocation that already exists. */
  it('leaves an item already on the channel alone', async () => {
    const item = await seedItem({
      name: 'Already there',
      condition: 'NM',
      prices: [{ source: 'tcgcsv', price: 1000 }],
    });
    await service.allocate(channelId, [item]);
    await prisma.channelAllocation.updateMany({
      where: { inventoryItemId: item },
      data: { price: 4242 },
    });

    const again = await service.allocate(channelId, [item]);

    expect(again.allocated).toEqual([]);
    expect(again.skipped[0]!.reason).toMatch(/already on this channel/);
    const allocation = await prisma.channelAllocation.findFirstOrThrow({
      where: { inventoryItemId: item },
    });
    expect(allocation.price).toBe(4242);
  });

  it('refuses a run larger than one batch rather than truncating it', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    await expect(service.allocate(channelId, ids)).rejects.toThrow(/at most 50/);
  });
});
