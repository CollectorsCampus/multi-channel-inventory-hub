import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { CatalogDuplicatesService } from './catalog-duplicates.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The two judgements that make the report usable rather than noise: only
 * ref-disjoint rows are duplicates (shared-namespace rows would have converged
 * at intake, so what remains split is deliberate), and same-named rows with
 * distinct collector numbers are reprints, excluded rather than ranked low.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let service: CatalogDuplicatesService;

async function seedItem(options: {
  name: string;
  game?: string;
  setName?: string;
  collectorNumber?: string;
  imageUrl?: string;
  refs: Record<string, string>;
  skus?: number;
}) {
  const item = await prisma.catalogItem.create({
    data: {
      name: options.name,
      searchName: options.name.toLowerCase(),
      game: options.game ?? 'Magic',
      setName: options.setName ?? null,
      collectorNumber: options.collectorNumber ?? null,
      imageUrl: options.imageUrl ?? null,
      externalRefs: {
        create: Object.entries(options.refs).map(([source, externalId]) => ({
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

describeDb('CatalogDuplicatesService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new CatalogDuplicatesService(prisma as unknown as PrismaService);
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

  /**
   * The measured production case: a Scryfall intake with no tcgplayer_id
   * beside a tcgcsv row. Disjoint namespaces, matching numbers — as sure as
   * it gets without a shared id.
   */
  it('finds a ref-disjoint pair, ranked by matching collector number', async () => {
    await seedItem({
      name: 'Sliver Legion',
      collectorNumber: '288',
      refs: { tcgcsv: '100', tcgplayer: '100' },
      skus: 1,
    });
    await seedItem({
      name: 'Sliver Legion',
      collectorNumber: '288',
      refs: { scryfall: 'abc-123' },
    });

    const groups = await service.findDuplicates();

    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe('number');
    expect(groups[0]!.items).toHaveLength(2);
    // What a merge would have to move rides along, because which row to keep
    // is decided by what is attached to it.
    expect(groups[0]!.items.map((i) => i.skuCount).sort()).toEqual([0, 1]);
  });

  /**
   * The gate itself. Two same-named rows created by the same source share its
   * namespace — that is what a legitimate reprint family looks like, and had
   * they been one product, intake would have converged them on the shared id.
   */
  it('reports nothing for same-named rows that share a namespace', async () => {
    await seedItem({ name: 'Charizard ex', game: 'Pokemon', refs: { tcgcsv: '1' } });
    await seedItem({ name: 'Charizard ex', game: 'Pokemon', refs: { tcgcsv: '2' } });

    expect(await service.findDuplicates()).toEqual([]);
  });

  /**
   * The exclusion that keeps the merge screen from inviting the catastrophic
   * mistake: same name, both numbered, numbers differ — two real printings.
   * Excluded outright, never ranked low.
   */
  it('excludes ref-disjoint rows whose collector numbers differ', async () => {
    await seedItem({
      name: 'Lightning Bolt',
      collectorNumber: '161',
      refs: { tcgcsv: '10', tcgplayer: '10' },
    });
    await seedItem({
      name: 'Lightning Bolt',
      collectorNumber: '117',
      refs: { scryfall: 'def-456' },
    });

    expect(await service.findDuplicates()).toEqual([]);
  });

  it('falls back to the image, then the bare name, in rank order', async () => {
    // Image-identical pair — one side unnumbered, so the number rank is out.
    await seedItem({
      name: 'Doctor Who Card',
      imageUrl: 'https://cdn.test/x.jpg',
      collectorNumber: '42',
      refs: { tcgcsv: '20', tcgplayer: '20' },
    });
    await seedItem({
      name: 'Doctor Who Card',
      imageUrl: 'https://cdn.test/x.jpg',
      refs: { scryfall: 'ghi-789' },
    });

    // Name-only pair.
    await seedItem({ name: 'Universes Card', refs: { tcgcsv: '30', tcgplayer: '30' } });
    await seedItem({ name: 'Universes Card', refs: { scryfall: 'jkl-012' } });

    const groups = await service.findDuplicates();

    expect(groups.map((g) => [g.name, g.confidence])).toEqual([
      ['Doctor Who Card', 'image'],
      ['Universes Card', 'name'],
    ]);
  });

  /** Same name in different games is different products, never compared. */
  it('never crosses games', async () => {
    await seedItem({ name: 'Pikachu', game: 'Pokemon', refs: { tcgcsv: '40', tcgplayer: '40' } });
    await seedItem({ name: 'Pikachu', game: 'Pokemon Japan', refs: { scryfall: 'mno-345' } });

    expect(await service.findDuplicates()).toEqual([]);
  });

  /**
   * Three-way: two rows sharing a namespace cluster together, and the third,
   * disjoint from both, still surfaces the group — as one group, not a pair
   * per combination.
   */
  it('clusters transitively rather than reporting per pair', async () => {
    await seedItem({ name: 'Trip Card', refs: { tcgcsv: '50', tcgplayer: '50' } });
    await seedItem({ name: 'Trip Card', refs: { tcgplayer: '51' } });
    await seedItem({ name: 'Trip Card', refs: { scryfall: 'pqr-678' } });

    const groups = await service.findDuplicates();

    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(3);
  });
});
