import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { CatalogImportService } from './catalog-import.service';
import { IntakeService } from '../inventory/intake.service';
import { InventoryService } from '../inventory/inventory.service';
import { AlertsService } from '../sync/alerts.service';
import type { CatalogService } from './catalog.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * What matters is the refresh contract: fill-empty-only everywhere, except
 * the image, which the import may replace — its URLs expire, and refreshing
 * them is the reason re-import exists.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: CatalogImportService;

const CARD = {
  id: 'GEN-1',
  name: 'Hex, Codemancer',
  collectorNumber: 'GEN-1',
  imageUrl: 'https://cdn.test/gen-1.webp?sig=first',
};

function request(overrides: Partial<Parameters<CatalogImportService['import']>[0]> = {}) {
  return {
    namespace: 'neuroscape',
    game: 'Neuroscape TCG',
    setName: 'Genesis',
    items: [CARD],
    ...overrides,
  };
}

describeDb('CatalogImportService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    const inventory = new InventoryService(prisma as unknown as PrismaService);
    const intake = new IntakeService(
      prisma as unknown as PrismaService,
      {} as unknown as CatalogService,
      inventory,
      new AlertsService(prisma as unknown as PrismaService),
    );
    service = new CatalogImportService(prisma as unknown as PrismaService, intake);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  it('creates an item under the imported namespace, dotted with the file namespace', async () => {
    const report = await service.import(request());

    expect(report.created).toBe(1);
    expect(report.problems).toEqual([]);

    const item = await prisma.catalogItem.findFirstOrThrow({ include: { externalRefs: true } });
    expect(item.name).toBe('Hex, Codemancer');
    expect(item.game).toBe('Neuroscape TCG');
    expect(item.setName).toBe('Genesis');
    expect(item.collectorNumber).toBe('GEN-1');
    expect(item.imageUrl).toBe(CARD.imageUrl);
    expect(item.externalRefs).toHaveLength(1);
    expect(item.externalRefs[0]).toMatchObject({
      source: 'imported',
      externalId: 'neuroscape.GEN-1',
    });
  });

  /**
   * The exception to fill-empty-only, and the reason re-import exists: the
   * image URL is replaced when it differs, because a signed URL that expired
   * yesterday would otherwise be pinned forever.
   */
  it('re-import refreshes a changed image but never the name', async () => {
    await service.import(request());

    const report = await service.import(
      request({
        items: [
          { ...CARD, name: 'Renamed By Mistake', imageUrl: 'https://cdn.test/gen-1.webp?sig=new' },
        ],
      }),
    );

    expect(report.created).toBe(0);
    expect(report.imagesRefreshed).toBe(1);
    const item = await prisma.catalogItem.findFirstOrThrow();
    // Fill-empty-only holds for identity: the stored name wins.
    expect(item.name).toBe('Hex, Codemancer');
    expect(item.imageUrl).toBe('https://cdn.test/gen-1.webp?sig=new');
  });

  it('re-import with identical data touches nothing and counts nothing', async () => {
    await service.import(request());

    const report = await service.import(request());

    expect(report.created).toBe(0);
    expect(report.imagesRefreshed).toBe(0);
    expect(await prisma.catalogItem.count()).toBe(1);
  });

  /** Problems are per row; the rest of the file still lands. */
  it('reports a bad id and a duplicate id, and imports the rest', async () => {
    const report = await service.import(
      request({
        items: [
          CARD,
          { id: 'GEN 2', name: 'Spaced Out' }, // space cannot form a sourceId
          { id: 'GEN-1', name: 'Same id again' },
          { id: 'GEN-3', name: 'Fine' },
        ],
      }),
    );

    expect(report.created).toBe(2);
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]!.message).toMatch(/cannot form a valid external id/);
    expect(report.problems[1]!.message).toMatch(/Duplicate id/);
  });

  it('refuses a run over the cap rather than truncating it', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ id: `C-${i}`, name: `Card ${i}` }));
    await expect(service.import(request({ items }))).rejects.toThrow(/exceeds the limit/);
  });

  /**
   * Two namespaces may reuse an id — that is what the namespace is for — and
   * the dot keeps the external ids distinct.
   */
  it('keeps identical ids in different namespaces apart', async () => {
    await service.import(request());
    await service.import(request({ namespace: 'other-game', game: 'Other Game' }));

    const refs = await prisma.catalogExternalRef.findMany({ orderBy: { externalId: 'asc' } });
    expect(refs.map((r) => r.externalId)).toEqual(['neuroscape.GEN-1', 'other-game.GEN-1']);
    expect(await prisma.catalogItem.count()).toBe(2);
  });
});
