import { describe, expect, it, vi } from 'vitest';
import type { CatalogCtx } from '@hub/connector-sdk';
import { runCatalogSourceContractTests } from '@hub/connector-sdk/testing';
import { createScryfallSource } from './scryfall';
import { usdStringToCents } from './money';

/**
 * Everything here runs against recorded response shapes, never the live API.
 * Scryfall is a free community service; a test suite hitting it on every CI run
 * is exactly the behaviour that gets a project blocked.
 *
 * The fixtures mirror what the real API returned during ADR 0002 evaluation,
 * including the part that matters: Black Lotus has no `tcgplayer_id` at all.
 */

const ctx = (): CatalogCtx => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  secrets: {},
});

const LIGHTNING_BOLT = {
  id: 'e3285e6b-3e79-4d7c-bf96-d920f973b122',
  name: 'Lightning Bolt',
  set_name: 'Masters 25',
  lang: 'en',
  tcgplayer_id: 697344,
  cardmarket_id: 12345,
  finishes: ['nonfoil', 'foil'],
  image_uris: { normal: 'https://cards.scryfall.io/normal/bolt.jpg' },
  prices: { usd: '2.49', usd_foil: '8.00' },
};

/** No tcgplayer_id — the real response for this printing omits it entirely. */
const BLACK_LOTUS = {
  id: 'bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd',
  name: 'Black Lotus',
  set_name: 'Limited Edition Alpha',
  lang: 'en',
  finishes: ['nonfoil'],
  image_uris: { normal: 'https://cards.scryfall.io/normal/lotus.jpg' },
  prices: { usd: null, usd_foil: null },
};

/** Foil-only printing: usd is null, usd_foil carries the price. */
const FOIL_ONLY = {
  id: 'foil-only-id',
  name: 'Shiny Thing',
  set_name: 'Promos',
  finishes: ['foil'],
  prices: { usd: null, usd_foil: '15.75' },
};

function fakeFetch(handler: (url: string) => { status: number; body?: unknown }) {
  return vi.fn(async (url: string) => {
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

const searchReturning = (cards: unknown[]) =>
  fakeFetch((url) =>
    url.includes('/cards/search')
      ? { status: 200, body: { object: 'list', data: cards } }
      : { status: 404 },
  );

describe('usdStringToCents', () => {
  it('converts without floating-point error', () => {
    // 2.49 * 100 is 248.99999999999997 in IEEE-754. This never touches a float.
    expect(usdStringToCents('2.49')).toBe(249);
    expect(usdStringToCents('0.01')).toBe(1);
    expect(usdStringToCents('1250.00')).toBe(125000);
    expect(usdStringToCents('0.07')).toBe(7);
    expect(usdStringToCents('10')).toBe(1000);
    expect(usdStringToCents('0')).toBe(0);
  });

  it('rounds a third decimal place', () => {
    expect(usdStringToCents('1.005')).toBe(101);
    expect(usdStringToCents('1.004')).toBe(100);
  });

  it('returns undefined for absent or malformed values', () => {
    expect(usdStringToCents(null)).toBeUndefined();
    expect(usdStringToCents(undefined)).toBeUndefined();
    expect(usdStringToCents('')).toBeUndefined();
    expect(usdStringToCents('n/a')).toBeUndefined();
    expect(usdStringToCents('-1.00')).toBeUndefined();
  });
});

describe('Scryfall catalog source', () => {
  it('identifies itself and accepts JSON', async () => {
    const doFetch = searchReturning([LIGHTNING_BOLT]);
    const source = createScryfallSource({ fetch: doFetch });

    await source.search(ctx(), { text: 'bolt' });

    const init = doFetch.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // Scryfall asks consumers to identify themselves; anonymous traffic gets 403.
    expect(headers['User-Agent']).toMatch(/InventoryHub/);
    expect(headers.Accept).toBe('application/json');
  });

  it('maps a card onto a candidate', async () => {
    const source = createScryfallSource({ fetch: searchReturning([LIGHTNING_BOLT]) });
    const [candidate] = await source.search(ctx(), { text: 'bolt' });

    expect(candidate).toEqual({
      sourceId: LIGHTNING_BOLT.id,
      name: 'Lightning Bolt',
      game: 'Magic',
      setName: 'Masters 25',
      imageUrl: 'https://cards.scryfall.io/normal/bolt.jpg',
      externalIds: {
        scryfall: LIGHTNING_BOLT.id,
        tcgplayer: '697344',
        cardmarket: '12345',
      },
      printings: ['NORMAL', 'FOIL'],
      marketPrice: 249,
      language: 'EN',
    });
  });

  /**
   * The ADR 0002 finding, pinned. Roughly a tenth of a modern set and many
   * older printings have no TCGPlayer id, and a blank one written to
   * CatalogExternalRef would never match anything.
   */
  it('omits the tcgplayer key entirely when Scryfall has no id', async () => {
    const source = createScryfallSource({ fetch: searchReturning([BLACK_LOTUS]) });
    const [candidate] = await source.search(ctx(), { text: 'lotus' });

    expect(candidate!.externalIds).toEqual({ scryfall: BLACK_LOTUS.id });
    expect(candidate!.externalIds).not.toHaveProperty('tcgplayer');
    expect(Object.keys(candidate!.externalIds)).not.toContain('tcgplayer');
  });

  it('omits marketPrice when no price is published', async () => {
    const source = createScryfallSource({ fetch: searchReturning([BLACK_LOTUS]) });
    const [candidate] = await source.search(ctx(), { text: 'lotus' });
    expect(candidate).not.toHaveProperty('marketPrice');
  });

  it('falls back to the foil price for a foil-only printing', async () => {
    const source = createScryfallSource({ fetch: searchReturning([FOIL_ONLY]) });
    const [candidate] = await source.search(ctx(), { text: 'shiny' });
    expect(candidate!.marketPrice).toBe(1575);
  });

  it('treats a 404 as "nothing matched" rather than an error', async () => {
    // Scryfall's search endpoint 404s when a query has no results.
    const source = createScryfallSource({ fetch: fakeFetch(() => ({ status: 404 })) });
    await expect(source.search(ctx(), { text: 'zzzz' })).resolves.toEqual([]);
  });

  it('does not call the API at all for an empty query', async () => {
    const doFetch = searchReturning([LIGHTNING_BOLT]);
    const source = createScryfallSource({ fetch: doFetch });

    await expect(source.search(ctx(), { text: '   ' })).resolves.toEqual([]);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('surfaces a real server error rather than swallowing it', async () => {
    const source = createScryfallSource({ fetch: fakeFetch(() => ({ status: 500 })) });
    await expect(source.search(ctx(), { text: 'bolt' })).rejects.toThrow(/responded 500/);
  });

  it('requests every printing, since intake picks a specific physical card', async () => {
    const doFetch = searchReturning([LIGHTNING_BOLT]);
    const source = createScryfallSource({ fetch: doFetch });

    await source.search(ctx(), { text: 'bolt' });

    expect(doFetch.mock.calls[0]![0]).toContain('unique=prints');
  });

  it('honours the requested limit', async () => {
    const source = createScryfallSource({
      fetch: searchReturning([LIGHTNING_BOLT, BLACK_LOTUS, FOIL_ONLY]),
    });
    expect(await source.search(ctx(), { text: 'a', limit: 2 })).toHaveLength(2);
  });

  it('narrows by set when asked', async () => {
    const doFetch = searchReturning([LIGHTNING_BOLT]);
    const source = createScryfallSource({ fetch: doFetch });

    await source.search(ctx(), { text: 'bolt', setName: 'Masters 25' });

    // Read the parameter back rather than decoding the raw URL: URLSearchParams
    // encodes spaces as "+", which decodeURIComponent does not reverse.
    const q = new URL(doFetch.mock.calls[0]![0]).searchParams.get('q');
    expect(q).toBe('bolt set:"Masters 25"');
  });

  describe('fetchById', () => {
    it('returns the card', async () => {
      const source = createScryfallSource({
        fetch: fakeFetch(() => ({ status: 200, body: LIGHTNING_BOLT })),
      });
      const card = await source.fetchById!(ctx(), LIGHTNING_BOLT.id);
      expect(card?.sourceId).toBe(LIGHTNING_BOLT.id);
    });

    it('returns null for an unknown id', async () => {
      const source = createScryfallSource({ fetch: fakeFetch(() => ({ status: 404 })) });
      await expect(source.fetchById!(ctx(), 'nope')).resolves.toBeNull();
    });

    it('does not call the API for a blank id', async () => {
      const doFetch = fakeFetch(() => ({ status: 200, body: LIGHTNING_BOLT }));
      const source = createScryfallSource({ fetch: doFetch });
      await expect(source.fetchById!(ctx(), '  ')).resolves.toBeNull();
      expect(doFetch).not.toHaveBeenCalled();
    });
  });
});

// The shared contract suite, against the same recorded shapes.
runCatalogSourceContractTests({
  source: createScryfallSource({
    fetch: fakeFetch((url) => {
      if (url.includes('/cards/search')) {
        const query = new URL(url).searchParams.get('q') ?? '';
        if (/zzzz/i.test(query)) return { status: 404 };
        return { status: 200, body: { object: 'list', data: [LIGHTNING_BOLT, BLACK_LOTUS] } };
      }
      if (url.includes(LIGHTNING_BOLT.id)) return { status: 200, body: LIGHTNING_BOLT };
      return { status: 404 };
    }),
  }),
  makeCtx: ctx,
  knownQuery: 'lightning bolt',
});
