import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { CatalogCtx } from '@hub/connector-sdk';
import { assertValidCatalogSource, supportsBulkIngest } from '@hub/connector-sdk';
import { createImportedSource } from './imported-source';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The source is what makes imported rows intakeable — intake re-fetches every
 * candidate server-side by `(sourceKey, sourceId)`, so `fetchById` answering
 * from the database is the whole point.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const ctx: CatalogCtx = {
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  secrets: {},
};

let prisma: PrismaClient;
let source: ReturnType<typeof createImportedSource>;

async function seed(options: {
  name: string;
  game?: string;
  setName?: string;
  imageUrl?: string;
  collectorNumber?: string;
  refs: Record<string, string>;
}) {
  await prisma.catalogItem.create({
    data: {
      name: options.name,
      searchName: options.name.toLowerCase(),
      game: options.game ?? 'Neuroscape TCG',
      setName: options.setName ?? null,
      imageUrl: options.imageUrl ?? null,
      collectorNumber: options.collectorNumber ?? null,
      externalRefs: {
        create: Object.entries(options.refs).map(([s, externalId]) => ({
          source: s,
          externalId,
        })),
      },
    },
  });
}

describeDb('imported catalog source', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    source = createImportedSource(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  it('is a valid source, and deliberately not ingestable', () => {
    assertValidCatalogSource(source);
    expect(supportsBulkIngest(source)).toBe(false);
  });

  it('searches only rows carrying an imported ref', async () => {
    await seed({
      name: 'Hex, Codemancer',
      setName: 'Genesis',
      imageUrl: 'https://cdn.test/gen-1.webp',
      collectorNumber: 'GEN-1',
      refs: { imported: 'neuroscape.GEN-1' },
    });
    // A tcgcsv-only row must never be answered for — its own source owns it.
    await seed({ name: 'Hexed Elsewhere', game: 'Pokemon', refs: { tcgcsv: '123' } });

    const results = await source.search(ctx, { text: 'hex' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sourceId: 'neuroscape.GEN-1',
      name: 'Hex, Codemancer',
      game: 'Neuroscape TCG',
      setName: 'Genesis',
      imageUrl: 'https://cdn.test/gen-1.webp',
      collectorNumber: 'GEN-1',
      externalIds: { imported: 'neuroscape.GEN-1' },
    });
  });

  it('narrows by game, and an empty query lists rather than throws', async () => {
    await seed({ name: 'Alpha', refs: { imported: 'ns.A-1' } });
    await seed({ name: 'Beta', game: 'Other Game', refs: { imported: 'other.B-1' } });

    // Unlike the CDN-backed sources there is nothing here to protect, so a
    // broad query is a browse, not an abuse.
    const all = await source.search(ctx, { text: '' });
    expect(all.map((c) => c.name)).toEqual(['Alpha', 'Beta']);

    const narrowed = await source.search(ctx, { text: '', game: 'Other Game' });
    expect(narrowed.map((c) => c.name)).toEqual(['Beta']);
  });

  it('fetchById resolves an imported id from the database, cold', async () => {
    await seed({ name: 'Hex, Codemancer', refs: { imported: 'neuroscape.GEN-1' } });

    const hit = await source.fetchById!(ctx, 'neuroscape.GEN-1');
    expect(hit?.name).toBe('Hex, Codemancer');

    expect(await source.fetchById!(ctx, 'neuroscape.GEN-999')).toBeNull();
  });
});
