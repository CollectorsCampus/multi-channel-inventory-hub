import { describe, expect, it, vi } from 'vitest';
import type { CatalogCtx } from '@hub/connector-sdk';
import { createPalworldSource } from './palworld';
import { cardName, toCandidate } from './cards';

/**
 * Recorded shapes, not invented ones: every field below was read off the live
 * English card database on 2026-08-17. Hitting it on each CI run would be the
 * same mistake as hammering Scryfall.
 */

const CARD = {
  id: 40,
  picture: 'ETD02/ETD02-001.png',
  card_number: 'ETD02-001',
  card_name: 'Mossanda – Guard Captain',
  card_kind: 'Pal',
  rare: 'TD',
  expansion: 'ETD02',
  expansion_name: 'Trial Deck "Dawn of Palpagos Green・Purple"',
  color: 'Green',
  type: 'Grass',
};

const BOOSTER_CARD = {
  id: 1,
  picture: 'EBP01/EBP01-001.png',
  card_number: 'EBP01-001',
  card_name: 'Jormuntide Ignis – Savage Lava Dragon',
  expansion: 'EBP01',
  expansion_name: 'Booster Pack "Dawn of Palpagos"',
};

const PRODUCTS = {
  products: [
    {
      year: '2026',
      items: [
        {
          code: 'EBP01',
          name: 'Booster Pack "Dawn of Palpagos"',
          type: 'pack',
          date: '2026.07.30',
        },
        { code: 'ETD01', name: 'Trial Deck "Dawn of Palpagos Red・Blue"', type: 'deck' },
        { code: 'ETD02', name: 'Trial Deck "Dawn of Palpagos Green・Purple"', type: 'deck' },
      ],
    },
  ],
};

const ctx = () => ({ secrets: {}, config: {} }) as unknown as CatalogCtx;

/** Serves the two endpoints, and counts calls so caching is assertable. */
function fakeFetch(cards = [CARD, BOOSTER_CARD]) {
  const calls: string[] = [];
  const fetchLike = vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.includes('/card-list-user/products')
      ? PRODUCTS
      : { page: 1, per_page: 100, total: cards.length, items: cards };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  return { fetchLike, calls };
}

describe('cardName', () => {
  /**
   * The format tcgcsv already uses for Pokémon (`Mega Charizard X ex -
   * 013/094`), so a Palworld card reads the same way everywhere downstream —
   * and the number is the only thing telling two printings of one Pal apart.
   */
  it('folds the collector number into the name', () => {
    expect(cardName(CARD)).toBe('Mossanda – Guard Captain - ETD02-001');
  });

  it('leaves a numberless card without a dangling separator', () => {
    expect(cardName({ card_name: 'Soul' })).toBe('Soul');
  });

  it('is empty for a row with no name, so the caller can drop it', () => {
    expect(cardName({ card_number: 'EBP01-001' })).toBe('');
  });
});

describe('toCandidate', () => {
  it('maps a card, with an absolute image URL', () => {
    const c = toCandidate(CARD, 'https://example.test/cardlist')!;
    expect(c.sourceId).toBe('40');
    expect(c.externalIds).toEqual({ palworld: '40' });
    expect(c.setName).toBe('Trial Deck "Dawn of Palpagos Green・Purple"');
    expect(c.imageUrl).toBe('https://example.test/cardlist/ETD02/ETD02-001.png');
    expect(c.game).toBe('Palworld');
    expect(c.language).toBe('EN');
  });

  /**
   * A publisher's database has no market. Claiming otherwise is what would put
   * a made-up figure in front of the repricing engine.
   */
  it('never carries a price or printings', () => {
    const c = toCandidate(CARD, 'https://example.test/cardlist')!;
    expect(c.marketPrice).toBeUndefined();
    expect(c.pricesByPrinting).toBeUndefined();
    expect(c.printings).toBeUndefined();
  });

  it('drops a row it could not key or display', () => {
    expect(toCandidate({ card_name: 'No id' }, 'https://x.test')).toBeNull();
    expect(toCandidate({ id: 7 }, 'https://x.test')).toBeNull();
  });
});

describe('the source', () => {
  it('searches the whole catalogue by name or collector number', async () => {
    const { fetchLike } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike, imageBase: 'https://x.test' });

    const byName = await source.search!(ctx(), { text: 'jormuntide' });
    expect(byName.map((c) => c.sourceId)).toEqual(['1']);

    const byNumber = await source.search!(ctx(), { text: 'ETD02-001' });
    expect(byNumber.map((c) => c.sourceId)).toEqual(['40']);
  });

  /**
   * Unscoped is a legitimate question here, unlike tcgcsv and CardTrader: the
   * whole catalogue is a few hundred rows and already in memory, so refusing
   * would save nothing and cost the operator a search.
   */
  it('answers an unscoped search rather than refusing it', async () => {
    const { fetchLike } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike, imageBase: 'https://x.test' });
    expect(await source.search!(ctx(), { text: '' })).toHaveLength(2);
  });

  it('answers nothing for a game it does not have', async () => {
    const { fetchLike } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike, imageBase: 'https://x.test' });
    expect(await source.search!(ctx(), { text: 'x', game: 'Pokemon' })).toEqual([]);
    expect(await source.listSets!(ctx(), 'Pokemon')).toEqual([]);
  });

  /**
   * The failure that broke a live SKU write mid-run for tcgcsv: `fetchById`
   * going blind after a restart because only browsed sets were indexed. It
   * cannot happen here — the cache is the whole catalogue.
   */
  it('resolves a card by id from cold', async () => {
    const { fetchLike } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike, imageBase: 'https://x.test' });

    const card = await source.fetchById!(ctx(), '40');
    expect(card?.name).toBe('Mossanda – Guard Captain - ETD02-001');
    expect(await source.fetchById!(ctx(), 'nope')).toBeNull();
  });

  it('lists the products as sets, keyed on the code a card carries', async () => {
    const { fetchLike } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike, imageBase: 'https://x.test' });

    const sets = await source.listSets!(ctx());
    expect(sets).toEqual([
      { setId: 'EBP01', name: 'Booster Pack "Dawn of Palpagos"', game: 'Palworld' },
      { setId: 'ETD01', name: 'Trial Deck "Dawn of Palpagos Red・Blue"', game: 'Palworld' },
      { setId: 'ETD02', name: 'Trial Deck "Dawn of Palpagos Green・Purple"', game: 'Palworld' },
    ]);

    const inSet = await source.fetchSet!(ctx(), 'EBP01');
    expect(inSet.map((c) => c.sourceId)).toEqual(['1']);
  });

  it('reads the catalogue once and serves the rest from cache', async () => {
    const { fetchLike, calls } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike, imageBase: 'https://x.test' });

    await source.search!(ctx(), { text: 'a' });
    await source.fetchById!(ctx(), '40');
    await source.fetchSet!(ctx(), 'EBP01');

    expect(calls.filter((u) => u.includes('/card-list-user/list'))).toHaveLength(1);
  });

  it('re-reads once the cache has expired', async () => {
    const { fetchLike, calls } = fakeFetch();
    let clock = 0;
    const source = createPalworldSource({
      fetch: fetchLike,
      imageBase: 'https://x.test',
      cacheTtlMs: 1000,
      now: () => clock,
    });

    await source.search!(ctx(), { text: '' });
    clock = 5000;
    await source.search!(ctx(), { text: '' });

    expect(calls.filter((u) => u.includes('/card-list-user/list'))).toHaveLength(2);
  });

  it('reports an HTTP failure rather than answering emptily', async () => {
    const fetchLike = vi.fn(
      async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response,
    );
    const source = createPalworldSource({ fetch: fetchLike });
    await expect(source.search!(ctx(), { text: 'x' })).rejects.toThrow(/responded 503/);
  });

  /**
   * Node's fetch sends no User-Agent, and tcgcsv's CDN 401s a blank one — a
   * failure every test missed because tests stub fetch and never exercise a
   * header. The rule is now that every HTTP client here sends one.
   */
  it('sends an explicit User-Agent', async () => {
    const { fetchLike } = fakeFetch();
    const source = createPalworldSource({ fetch: fetchLike });
    await source.search!(ctx(), { text: '' });

    const init = fetchLike.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBeTruthy();
  });
});
