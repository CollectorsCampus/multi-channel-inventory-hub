import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { CatalogCandidate, CatalogSource } from '@hub/connector-sdk';
import { CatalogIngestService } from './catalog-ingest.service';
import { IntakeService } from '../inventory/intake.service';
import { InventoryService } from '../inventory/inventory.service';
import type { CatalogService } from './catalog.service';
import type { CatalogSourceRegistry } from './catalog-source-registry.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Ingest against a real database.
 *
 * The properties worth testing are all about running it twice: an ingest is a
 * re-read of an authoritative source, so it happens repeatedly and must not
 * duplicate an item, must not churn rows that did not change, and must not lose
 * a whole run to one unreadable set.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const card = (over: Partial<CatalogCandidate> = {}): CatalogCandidate => ({
  sourceId: '100',
  name: 'Pikachu ex',
  game: 'Pokemon',
  setName: 'Surging Sparks',
  externalIds: { tcgcsv: '100', tcgplayer: '100' },
  ...over,
});

let prisma: PrismaClient;
let ingest: CatalogIngestService;
let listSets: ReturnType<typeof vi.fn>;
let fetchSet: ReturnType<typeof vi.fn>;

describeDb('CatalogIngestService', () => {
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

    listSets = vi.fn(async () => [
      { setId: '3:1', name: 'Surging Sparks', game: 'Pokemon' },
      { setId: '3:2', name: 'Prismatic Evolutions', game: 'Pokemon' },
    ]);
    fetchSet = vi.fn(async (_ctx: unknown, setId: string) =>
      setId === '3:1'
        ? [card(), card({ sourceId: '101', name: 'Charizard ex', externalIds: { tcgcsv: '101' } })]
        : [
            card({
              sourceId: '200',
              name: 'Eevee',
              setName: 'Prismatic Evolutions',
              externalIds: { tcgcsv: '200' },
            }),
          ],
    );

    const source = {
      key: 'tcgcsv',
      displayName: 'tcgcsv',
      games: [],
      search: vi.fn(async () => []),
      listSets,
      fetchSet,
    } as unknown as CatalogSource;

    const registry = { get: vi.fn(() => source) } as unknown as CatalogSourceRegistry;
    const catalog = {} as unknown as CatalogService;
    const inventory = new InventoryService(prisma as unknown as PrismaService);
    const intake = new IntakeService(prisma as unknown as PrismaService, catalog, inventory);

    ingest = new CatalogIngestService(registry, intake);
  });

  it('creates a catalog item per product, with its external ids', async () => {
    const report = await ingest.ingest({ sourceKey: 'tcgcsv' });

    expect(report.sets).toBe(2);
    expect(report.products).toBe(3);
    expect(report.created).toBe(3);
    expect(await prisma.catalogItem.count()).toBe(3);

    // Both namespaces recorded, which is what a future TCGPlayer listing is
    // matched on.
    const refs = await prisma.catalogExternalRef.findMany({ where: { externalId: '100' } });
    expect(refs.map((r) => r.source).sort()).toEqual(['tcgcsv', 'tcgplayer']);
  });

  /** The property that makes a scheduled ingest safe to run nightly. */
  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    await ingest.ingest({ sourceKey: 'tcgcsv' });
    const again = await ingest.ingest({ sourceKey: 'tcgcsv' });

    expect(again.created).toBe(0);
    expect(again.refreshed).toBe(0);
    expect(again.unchanged).toBe(3);
    expect(await prisma.catalogItem.count()).toBe(3);
  });

  it('refreshes an item whose name changed at the source', async () => {
    await ingest.ingest({ sourceKey: 'tcgcsv' });

    fetchSet.mockImplementation(async (_ctx: unknown, setId: string) =>
      setId === '3:1' ? [card({ name: 'Pikachu ex (Full Art)' })] : [],
    );

    const again = await ingest.ingest({ sourceKey: 'tcgcsv' });

    expect(again.refreshed).toBe(1);
    const item = await prisma.catalogItem.findFirstOrThrow({
      where: { searchName: { contains: 'full art' } },
    });
    expect(item.name).toBe('Pikachu ex (Full Art)');
    // searchName is what the browser filters on, so it must move with the name.
    expect(item.searchName).toBe('pikachu ex (full art)');
  });

  /**
   * A full-game ingest is minutes of downloads. Discarding all of it because one
   * file 404s would make the feature unusable exactly when a source is flaky.
   */
  it('reports a failed set and still ingests the rest', async () => {
    fetchSet.mockImplementation(async (_ctx: unknown, setId: string) => {
      if (setId === '3:1') throw new Error('tcgcsv responded 404');
      return [card({ sourceId: '200', name: 'Eevee', externalIds: { tcgcsv: '200' } })];
    });

    const report = await ingest.ingest({ sourceKey: 'tcgcsv' });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.message).toMatch(/404/);
    expect(report.sets).toBe(1);
    expect(report.created).toBe(1);
  });

  it('ingests only the sets asked for', async () => {
    const report = await ingest.ingest({ sourceKey: 'tcgcsv', setIds: ['3:2'] });

    expect(report.sets).toBe(1);
    expect(fetchSet).toHaveBeenCalledTimes(1);
    expect(await prisma.catalogItem.count()).toBe(1);
  });

  /**
   * Refused rather than truncated: a catalog that looks complete and is not is
   * worse than an error a caller has to answer.
   */
  it('refuses a run wider than the set cap instead of truncating it', async () => {
    await expect(ingest.ingest({ sourceKey: 'tcgcsv', maxSets: 1 })).rejects.toThrow(
      /above the limit/i,
    );

    expect(fetchSet).not.toHaveBeenCalled();
    expect(await prisma.catalogItem.count()).toBe(0);
  });

  it('refuses a source that cannot enumerate its sets', async () => {
    const registry = {
      get: vi.fn(() => ({ key: 'scryfall', displayName: 'Scryfall', games: [], search: vi.fn() })),
    } as unknown as CatalogSourceRegistry;
    const inventory = new InventoryService(prisma as unknown as PrismaService);
    const intake = new IntakeService(
      prisma as unknown as PrismaService,
      {} as unknown as CatalogService,
      inventory,
    );

    const limited = new CatalogIngestService(registry, intake);

    await expect(limited.ingest({ sourceKey: 'scryfall' })).rejects.toThrow(/does not enumerate/i);
  });

  /** Linking is identity. An ingest must never look like stock arriving. */
  it('credits no stock and records no movement', async () => {
    await ingest.ingest({ sourceKey: 'tcgcsv' });

    expect(await prisma.inventoryItem.count()).toBe(0);
    expect(await prisma.sku.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
  });
});
