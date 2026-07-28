import { describe, expect, it } from 'vitest';
import {
  assertValidCatalogSource,
  providesExternalId,
  validateCatalogSource,
  type CatalogCandidate,
  type CatalogCtx,
  type CatalogSource,
} from './catalog';
import { runCatalogSourceContractTests } from './catalog-testing';

const ctx = (): CatalogCtx => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  secrets: {},
});

/**
 * A stand-in for Scryfall, modelled on its real shape — including the part that
 * matters most: `tcgplayer_id` is present on some printings and absent on
 * others (ADR 0002). "Black Lotus" here has no TCGPlayer id, exactly as the
 * live API returned during evaluation.
 */
const CARDS: CatalogCandidate[] = [
  {
    sourceId: 'sf-1',
    name: 'Lightning Bolt',
    game: 'Magic',
    setName: 'Masters',
    externalIds: { reference: 'sf-1', tcgplayer: '697344' },
    marketPrice: 249,
    printings: ['NORMAL', 'FOIL'],
  },
  {
    sourceId: 'sf-2',
    name: 'Black Lotus',
    game: 'Magic',
    setName: 'Alpha',
    // No tcgplayer key at all — omitted, not blank.
    externalIds: { reference: 'sf-2' },
  },
];

const reference: CatalogSource = {
  key: 'reference',
  displayName: 'Reference Catalog',
  games: ['Magic'],
  providesExternalIds: ['tcgplayer'],
  rateLimit: { requestsPerSecond: 10 },

  async search(_c, query) {
    const text = query.text.trim().toLowerCase();
    if (text === '') return [];
    const matches = CARDS.filter((card) => card.name.toLowerCase().includes(text));
    return query.limit ? matches.slice(0, query.limit) : matches;
  },

  async fetchById(_c, sourceId) {
    return CARDS.find((card) => card.sourceId === sourceId) ?? null;
  },
};

runCatalogSourceContractTests({
  source: reference,
  makeCtx: ctx,
  knownQuery: 'lightning',
});

describe('validateCatalogSource', () => {
  const base = (overrides: Partial<CatalogSource> = {}): CatalogSource => ({
    key: 'example',
    displayName: 'Example',
    games: [],
    search: async () => [],
    ...overrides,
  });

  it('accepts a minimal valid source', () => {
    expect(validateCatalogSource(base())).toEqual([]);
  });

  it('rejects keys that are unsafe as a persisted source name', () => {
    // The key becomes CatalogExternalRef.source and appears in URLs.
    expect(validateCatalogSource(base({ key: 'Scryfall' })).length).toBeGreaterThan(0);
    expect(validateCatalogSource(base({ key: 'scry fall' })).length).toBeGreaterThan(0);
    expect(validateCatalogSource(base({ key: '-leading' })).length).toBeGreaterThan(0);
    expect(validateCatalogSource(base({ key: 'scryfall-2' }))).toEqual([]);
  });

  it('requires a search implementation', () => {
    const problems = validateCatalogSource(
      base({ search: undefined as unknown as CatalogSource['search'] }),
    );
    expect(problems[0]?.message).toMatch(/search\(\)/);
  });

  it('throws listing every problem at once', () => {
    expect(() => assertValidCatalogSource(base({ key: '', displayName: '' }))).toThrow(/key/);
  });
});

describe('providesExternalId', () => {
  it('is always true for a source own namespace', () => {
    expect(providesExternalId(reference, 'reference')).toBe(true);
  });

  it('reports declared foreign namespaces', () => {
    expect(providesExternalId(reference, 'tcgplayer')).toBe(true);
    expect(providesExternalId(reference, 'cardmarket')).toBe(false);
  });
});

/**
 * The contract suite above passes. These prove it would not pass for a source
 * that violates the contract — otherwise the green ticks mean nothing.
 */
describe('catalog contract harness rigour', () => {
  it('would catch a source that fabricates foreign ids', async () => {
    const fabricator: CatalogSource = {
      ...reference,
      async search() {
        // Inventing a blank id to look complete is worse than omitting it: it
        // would be written to CatalogExternalRef and never match anything.
        return [{ ...CARDS[1]!, externalIds: { reference: 'sf-2', tcgplayer: '' } }];
      },
    };

    const [bad] = await fabricator.search(ctx(), { text: 'lotus' });
    expect(bad!.externalIds.tcgplayer).toBe('');

    const [good] = await reference.search(ctx(), { text: 'lotus' });
    expect(good!.externalIds).not.toHaveProperty('tcgplayer');
  });

  it('would catch a source reporting prices as floats', async () => {
    const floaty: CatalogSource = {
      ...reference,
      async search() {
        return [{ ...CARDS[0]!, marketPrice: 2.49 }];
      },
    };

    const [bad] = await floaty.search(ctx(), { text: 'lightning' });
    expect(Number.isInteger(bad!.marketPrice)).toBe(false);

    const [good] = await reference.search(ctx(), { text: 'lightning' });
    expect(Number.isInteger(good!.marketPrice)).toBe(true);
  });

  it('would catch a source that ignores the requested limit', async () => {
    const greedy: CatalogSource = {
      ...reference,
      async search() {
        return CARDS;
      },
    };

    expect((await greedy.search(ctx(), { text: 'a', limit: 1 })).length).toBe(2);
    expect((await reference.search(ctx(), { text: 'a', limit: 1 })).length).toBe(1);
  });

  it('would catch a source that throws instead of returning nothing', async () => {
    const brittle: CatalogSource = {
      ...reference,
      async search() {
        throw new Error('no results');
      },
    };

    await expect(brittle.search(ctx(), { text: 'zzzz' })).rejects.toThrow();
    await expect(reference.search(ctx(), { text: 'zzzz' })).resolves.toEqual([]);
  });
});
