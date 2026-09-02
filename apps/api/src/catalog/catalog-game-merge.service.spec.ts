import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { CatalogGameMergeService } from './catalog-game-merge.service';
import { CatalogMergeService } from './catalog-merge.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The judgement worth pinning: pairs come only from exact, unique collector
 * numbers; everything ambiguous or contradicted is skipped with a reason; and
 * the into side survives, carrying the from side's SKUs and refs.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: CatalogGameMergeService;

async function seed(options: {
  name: string;
  game: string;
  setName?: string;
  collectorNumber?: string;
  refs?: Record<string, string>;
  skus?: number;
}) {
  const item = await prisma.catalogItem.create({
    data: {
      name: options.name,
      searchName: options.name.toLowerCase(),
      game: options.game,
      setName: options.setName ?? null,
      collectorNumber: options.collectorNumber ?? null,
      externalRefs: {
        create: Object.entries(options.refs ?? {}).map(([source, externalId]) => ({
          source,
          externalId,
        })),
      },
      skus: {
        create: Array.from({ length: options.skus ?? 0 }, (_, i) => ({
          condition: 'NM',
          printing: `P${i}`,
          language: 'EN',
        })),
      },
    },
  });
  return item.id;
}

/** The measured Palworld shape: Bushiroad spellings on one side, tcgcsv's on the other. */
const FROM = 'Palworld';
const INTO = 'Palworld OFFICIAL CARD GAME';

describeDb('CatalogGameMergeService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new CatalogGameMergeService(
      prisma as unknown as PrismaService,
      new CatalogMergeService(prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  it('pairs by exact collector number across differing names and set spellings', async () => {
    await seed({
      name: 'Jormuntide Ignis – Savage Lava Dragon - EBP01-001',
      game: FROM,
      setName: 'Booster Pack "Dawn of Palpagos"',
      collectorNumber: 'EBP01-001',
      refs: { palworld: '79' },
      skus: 1,
    });
    await seed({
      name: 'Jormuntide Ignis - Savage Lava Dragon',
      game: INTO,
      setName: 'BP01: Dawn of Palpagos',
      collectorNumber: 'EBP01-001',
      refs: { tcgcsv: '713879', tcgplayer: '713879' },
    });

    const preview = await service.preview(FROM, INTO);

    expect(preview.pairs).toHaveLength(1);
    expect(preview.pairs[0]).toMatchObject({ collectorNumber: 'EBP01-001', skuCount: 1 });
    expect(preview.skipped).toEqual([]);
  });

  it('merges the from side into the into side, moving SKUs and refs', async () => {
    const fromId = await seed({
      name: 'Suzaku – Hellfire Wings - EBP01-002',
      game: FROM,
      collectorNumber: 'EBP01-002',
      refs: { palworld: '82' },
      skus: 2,
    });
    const intoId = await seed({
      name: 'Suzaku - Hellfire Wings',
      game: INTO,
      setName: 'BP01: Dawn of Palpagos',
      collectorNumber: 'EBP01-002',
      refs: { tcgcsv: '713880', tcgplayer: '713880' },
    });

    const report = await service.mergeGames(FROM, INTO);

    expect(report.merged).toBe(1);
    expect(report.problems).toEqual([]);

    // The survivor keeps the marketplace spellings — the repricing argument —
    // and now carries every namespace, which is what makes the merge permanent.
    const survivor = await prisma.catalogItem.findUniqueOrThrow({
      where: { id: intoId },
      include: { externalRefs: true, skus: true },
    });
    expect(survivor.setName).toBe('BP01: Dawn of Palpagos');
    expect(survivor.skus).toHaveLength(2);
    expect(survivor.externalRefs.map((r) => r.source).sort()).toEqual([
      'palworld',
      'tcgcsv',
      'tcgplayer',
    ]);
    expect(await prisma.catalogItem.findUnique({ where: { id: fromId } })).toBeNull();
  });

  it('skips the unnumbered, the unmatched, and the ambiguous, each with its reason', async () => {
    await seed({ name: 'Booster Box', game: FROM }); // sealed: no number
    await seed({ name: 'Lonely Card', game: FROM, collectorNumber: 'EBP01-090' });
    await seed({ name: 'Twin A', game: FROM, collectorNumber: 'EBP01-050' });
    await seed({ name: 'Twin B', game: FROM, collectorNumber: 'EBP01-050' });
    await seed({ name: 'Counterpart', game: INTO, collectorNumber: 'EBP01-050' });

    const preview = await service.preview(FROM, INTO);

    expect(preview.pairs).toEqual([]);
    expect(preview.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no collector number/),
        expect.stringMatching(/no Palworld OFFICIAL CARD GAME item carries "EBP01-090"/),
        expect.stringMatching(/appears on more than one/),
      ]),
    );
  });

  /**
   * A shared namespace with different ids is that source saying "two different
   * products", and its word outranks a matching number.
   */
  it('refuses a pair whose sides share a ref namespace', async () => {
    await seed({
      name: 'Contradicted',
      game: FROM,
      collectorNumber: 'EBP01-010',
      refs: { tcgplayer: '111' },
    });
    await seed({
      name: 'Contradicted Too',
      game: INTO,
      collectorNumber: 'EBP01-010',
      refs: { tcgplayer: '222' },
    });

    const preview = await service.preview(FROM, INTO);

    expect(preview.pairs).toEqual([]);
    expect(preview.skipped[0]!.reason).toMatch(/tcgplayer ids that differ/);
  });

  it('a refused pair reports its problem and the rest still land', async () => {
    // This pair collides on the SKU natural key with stock on the duplicate,
    // which CatalogMergeService refuses.
    const fromBlocked = await seed({
      name: 'Blocked',
      game: FROM,
      collectorNumber: 'EBP01-020',
      refs: { palworld: '1' },
    });
    const blockedSku = await prisma.sku.create({
      data: { catalogItemId: fromBlocked, condition: 'NM', printing: 'NORMAL', language: 'EN' },
    });
    await prisma.inventoryItem.create({ data: { skuId: blockedSku.id, quantityOnHand: 3 } });
    const intoBlocked = await seed({
      name: 'Blocked Into',
      game: INTO,
      collectorNumber: 'EBP01-020',
      refs: { tcgcsv: '2' },
    });
    await prisma.sku.create({
      data: { catalogItemId: intoBlocked, condition: 'NM', printing: 'NORMAL', language: 'EN' },
    });

    await seed({
      name: 'Fine',
      game: FROM,
      collectorNumber: 'EBP01-021',
      refs: { palworld: '3' },
      skus: 1,
    });
    await seed({
      name: 'Fine Into',
      game: INTO,
      collectorNumber: 'EBP01-021',
      refs: { tcgcsv: '4' },
    });

    const report = await service.mergeGames(FROM, INTO);

    expect(report.merged).toBe(1);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]!.collectorNumber).toBe('EBP01-020');
    // The blocked pair's rows both survive, untouched.
    expect(await prisma.catalogItem.count({ where: { collectorNumber: 'EBP01-020' } })).toBe(2);
  });

  it('refuses a self-merge and an empty game by name', async () => {
    await seed({ name: 'Card', game: FROM, collectorNumber: 'EBP01-001' });

    await expect(service.preview(FROM, FROM)).rejects.toThrow(/must differ/);
    await expect(service.preview(FROM, 'No Such Game')).rejects.toThrow(/No catalog items carry/);
  });
});
