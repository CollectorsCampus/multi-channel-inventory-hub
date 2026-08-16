import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { CatalogSource } from '@hub/connector-sdk';
import { RepriceService } from './reprice.service';
import { encodeRepricingPolicy, type RepricingPolicy } from './repricing';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import type { CatalogCredentialsService } from '../catalog/catalog-credentials.service';
import type { OutboundQueue } from '../queue/outbound-queue.service';
import type { AlertsService } from '../sync/alerts.service';

/**
 * The sweep against a real database, with the catalog source and the queue
 * faked at their seams.
 *
 * What is worth pinning is the judgement boundary: a foil is priced off the
 * foil's market and never the normal's, an undeclared condition is never
 * repriced, a small move applies itself while a huge one waits for a human,
 * and a decided proposal leaves no residue.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: RepriceService;
let enqueue: ReturnType<typeof vi.fn>;
let raiseFlag: ReturnType<typeof vi.fn>;
let clearFlag: ReturnType<typeof vi.fn>;
let channelId: string;

const TCGCSV_ID = '696676';

const POLICY: RepricingPolicy = {
  enabled: true,
  conditionPercents: { NM: 100, LP: 80 },
  autoApplyMaxPct: 10,
};

function fakeTcgcsv(prices: Record<string, number>): CatalogSource {
  return {
    key: 'tcgcsv',
    displayName: 'tcgcsv',
    async search() {
      return [];
    },
    async listSets() {
      return [{ setId: '3:100', name: 'Test Set', game: 'Pokemon' }];
    },
    async fetchSet() {
      return [
        {
          sourceId: TCGCSV_ID,
          name: 'Pikachu ex',
          externalIds: { tcgcsv: TCGCSV_ID, tcgplayer: TCGCSV_ID },
          pricesByPrinting: prices,
        },
      ];
    },
  } as unknown as CatalogSource;
}

function buildService(source: CatalogSource) {
  const registry = {
    has: (key: string) => key === source.key,
    get: () => source,
  } as unknown as CatalogSourceRegistry;
  const credentials = {
    loadSecrets: async () => ({}),
  } as unknown as CatalogCredentialsService;
  enqueue = vi.fn(async () => {});
  raiseFlag = vi.fn(async () => ({ id: 'a', occurrences: 1 }));
  clearFlag = vi.fn(async () => true);

  return new RepriceService(
    prisma as unknown as PrismaService,
    registry,
    credentials,
    { enqueue } as unknown as OutboundQueue,
    { raiseFlag, clearFlag } as unknown as AlertsService,
  );
}

async function seed(options: {
  condition?: string;
  printing?: string;
  price?: number | null;
  policy?: RepricingPolicy;
  quantityOnHand?: number;
}) {
  const item = await prisma.catalogItem.create({
    data: {
      name: 'Pikachu ex',
      searchName: 'pikachu ex',
      game: 'Pokemon',
      setName: 'Test Set',
      externalRefs: {
        create: [
          { source: 'tcgcsv', externalId: TCGCSV_ID },
          { source: 'tcgplayer', externalId: TCGCSV_ID },
        ],
      },
    },
  });
  const sku = await prisma.sku.create({
    data: {
      catalogItemId: item.id,
      condition: options.condition ?? 'NM',
      printing: options.printing ?? 'NORMAL',
      language: 'EN',
    },
  });
  const inventory = await prisma.inventoryItem.create({
    data: { skuId: sku.id, quantityOnHand: options.quantityOnHand ?? 1 },
  });
  const channel = await prisma.channelInstance.create({
    data: {
      connectorKey: 'shopify',
      displayName: 'Test Store',
      config: '{}',
      repricingPolicy: encodeRepricingPolicy(options.policy ?? POLICY),
    },
  });
  channelId = channel.id;
  const allocation = await prisma.channelAllocation.create({
    data: {
      inventoryItemId: inventory.id,
      channelInstanceId: channel.id,
      mode: 'pooled',
      price: options.price === undefined ? 1000 : options.price,
      externalListingId: 'gid://shopify/ProductVariant/1',
    },
  });
  return { catalogItemId: item.id, allocationId: allocation.id };
}

describeDb('RepriceService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.repriceProposal.deleteMany();
    await prisma.marketPrice.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();
    await prisma.channelInstance.deleteMany();
  });

  it('records the market figure with the previous kept for was/now', async () => {
    const { catalogItemId } = await seed({});
    service = buildService(fakeTcgcsv({ NORMAL: 1050 }));
    await service.sweep();

    service = buildService(fakeTcgcsv({ NORMAL: 1100 }));
    await service.sweep();

    const row = await prisma.marketPrice.findUniqueOrThrow({
      where: {
        catalogItemId_source_printing: { catalogItemId, source: 'tcgcsv', printing: 'NORMAL' },
      },
    });
    expect(row.price).toBe(1100);
    expect(row.previousPrice).toBe(1050);
  });

  it('auto-applies a move inside the threshold and queues the price push', async () => {
    const { allocationId } = await seed({ price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 1050 }));

    const report = await service.sweep();

    expect(report.autoApplied).toBe(1);
    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.price).toBe(1050);
    expect(enqueue).toHaveBeenCalledWith('shopify', {
      channelInstanceId: channelId,
      allocationId,
      operation: 'price',
    });
  });

  it('sends a huge move to review instead of applying it', async () => {
    const { allocationId } = await seed({ price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 2000 }));

    const report = await service.sweep();

    expect(report.proposed).toBe(1);
    expect(report.autoApplied).toBe(0);
    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    // Untouched until a human says so.
    expect(allocation.price).toBe(1000);

    const proposal = await prisma.repriceProposal.findUniqueOrThrow({
      where: { allocationId },
    });
    expect(proposal.proposedPrice).toBe(2000);
    expect(proposal.currentPrice).toBe(1000);
    expect(raiseFlag).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reprice_review' }));
  });

  /**
   * Reviewing a price means going and looking at the market it came from, so
   * the row has to carry the ids that address that page. Ids, not URLs: which
   * sources have a linkable public page is the web app's judgement, and it has
   * already changed once when Cardmarket went behind bot protection.
   */
  it('carries the catalogue ids on a proposal, so the review can link out', async () => {
    await seed({ price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 2000 }));
    await service.sweep();

    const [row] = await service.listProposals();

    expect(row!.externalIds).toEqual({ tcgcsv: TCGCSV_ID, tcgplayer: TCGCSV_ID });
  });

  /**
   * The whole reason pricesByPrinting exists: a foil is priced off the foil's
   * market. With no foil figure published there is no answer — never the
   * normal's number by fallback.
   */
  it('prices a foil off the foil market, and skips it when only normal is priced', async () => {
    const { allocationId } = await seed({ printing: 'FOIL', price: 2000 });

    service = buildService(fakeTcgcsv({ NORMAL: 1000, FOIL: 2100 }));
    await service.sweep();
    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.price).toBe(2100);

    service = buildService(fakeTcgcsv({ NORMAL: 999 }));
    const report = await service.sweep();
    expect(report.autoApplied).toBe(0);
    expect(report.proposed).toBe(0);
  });

  it('never reprices a condition the operator has not declared', async () => {
    await seed({ condition: 'MP', price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 5000 }));

    const report = await service.sweep();

    expect(report.autoApplied).toBe(0);
    expect(report.proposed).toBe(0);
  });

  it('does nothing at all for a channel with no active policy', async () => {
    await seed({ price: 1000, policy: { conditionPercents: { NM: 100 } } }); // not enabled
    service = buildService(fakeTcgcsv({ NORMAL: 5000 }));

    const report = await service.sweep();
    expect(report.autoApplied + report.proposed).toBe(0);
  });

  it('clears a stale proposal once the market comes back within the threshold', async () => {
    await seed({ price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 2000 }));
    await service.sweep();
    expect(await prisma.repriceProposal.count()).toBe(1);

    service = buildService(fakeTcgcsv({ NORMAL: 1000 }));
    await service.sweep();
    expect(await prisma.repriceProposal.count()).toBe(0);
    expect(clearFlag).toHaveBeenCalledWith('reprice_review', channelId, 'pricing:sweep');
  });

  /**
   * The toggle gates repricing, not market data: the zero-stock item's figure
   * is still recorded, so the catalogue stays current for when it restocks.
   */
  it('skips a zero-stock item under in-stock only, but still records its market price', async () => {
    const { allocationId } = await seed({
      price: 1000,
      quantityOnHand: 0,
      policy: { ...POLICY, inStockOnly: true },
    });
    service = buildService(fakeTcgcsv({ NORMAL: 1050 }));

    const report = await service.sweep();

    expect(report.autoApplied).toBe(0);
    expect(report.proposed).toBe(0);
    expect(report.pricesRecorded).toBe(1);
    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.price).toBe(1000);
  });

  it('clears a stale proposal once the item sells out under in-stock only', async () => {
    const { allocationId } = await seed({ price: 1000, policy: { ...POLICY, inStockOnly: true } });
    service = buildService(fakeTcgcsv({ NORMAL: 2000 }));
    await service.sweep();
    expect(await prisma.repriceProposal.count()).toBe(1);

    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
      select: { inventoryItemId: true },
    });
    await prisma.inventoryItem.update({
      where: { id: allocation.inventoryItemId },
      data: { quantityOnHand: 0 },
    });

    await service.sweep();
    expect(await prisma.repriceProposal.count()).toBe(0);
  });

  it('applies a proposal on request: price written, push queued, row gone', async () => {
    const { allocationId } = await seed({ price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 2000 }));
    await service.sweep();
    const proposal = await prisma.repriceProposal.findUniqueOrThrow({ where: { allocationId } });

    await service.applyProposal(proposal.id);

    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.price).toBe(2000);
    expect(enqueue).toHaveBeenCalledWith(
      'shopify',
      expect.objectContaining({ allocationId, operation: 'price' }),
    );
    expect(await prisma.repriceProposal.count()).toBe(0);
  });

  it('dismisses a proposal without touching the price', async () => {
    const { allocationId } = await seed({ price: 1000 });
    service = buildService(fakeTcgcsv({ NORMAL: 2000 }));
    await service.sweep();
    const proposal = await prisma.repriceProposal.findUniqueOrThrow({ where: { allocationId } });

    await service.dismissProposal(proposal.id);

    expect(await prisma.repriceProposal.count()).toBe(0);
    const allocation = await prisma.channelAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.price).toBe(1000);
  });
});
