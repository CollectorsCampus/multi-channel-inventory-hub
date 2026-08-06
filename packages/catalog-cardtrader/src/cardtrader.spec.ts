import { describe, expect, it, vi } from 'vitest';
import { validateCatalogSource, type CatalogCtx } from '@hub/connector-sdk';
import { createCardTraderSource } from './cardtrader';
import type { CtBlueprint, CtExpansion, CtGame } from './blueprints';

/**
 * Shapes modelled on real `/games`, `/expansions` and `/blueprints/export`
 * responses read 2026-08-03/04 with the operator's own token
 * (`private/cardtrader/`) — see `blueprints.spec.ts` for the same fixtures'
 * field-level mapping tests.
 */
const GAMES: CtGame[] = [
  { id: 1, name: 'Magic', display_name: 'Magic: the Gathering' },
  { id: 5, name: 'Pokémon', display_name: 'Pokémon' },
];

const EXPANSIONS: CtExpansion[] = [
  { id: 979, game_id: 1, code: 'm20', name: 'Core Set 2020' },
  { id: 1472, game_id: 5, code: 'bs', name: 'Base Set' },
  { id: 1468, game_id: 5, code: 'pr1', name: 'Wizards of the Coast Era Promos' },
  // Overlaps "Base Set" by containment, so an exact-match preference is the
  // only thing that keeps a search for "Base Set" from also downloading this.
  { id: 1473, game_id: 5, code: 'bs2', name: 'Base Set 2' },
];

const magicSingle: CtBlueprint = {
  id: 57957,
  name: 'Chandra, Awakened Inferno',
  version: null,
  game_id: 1,
  expansion_id: 979,
  image_url: 'https://cardtrader.com/uploads/blueprints/image/57957/preview_chandra.jpg',
  editable_properties: [{ name: 'condition' }, { name: 'mtg_language' }],
  card_market_ids: [377187],
  tcg_player_id: 192222,
  scryfall_id: '49d2a680-4f3b-4bfa-b77b-d2dfaced9f23',
};

const pokemonAlakazam: CtBlueprint = {
  id: 111148,
  name: 'Alakazam',
  version: 'Holo Rare | 1/102',
  game_id: 5,
  expansion_id: 1472,
  image_url: 'https://cardtrader.com/uploads/blueprints/image/111148/preview_alakazam.jpg',
  editable_properties: [{ name: 'condition' }, { name: 'pokemon_language' }],
  card_market_ids: [273696],
  tcg_player_id: 42346,
  scryfall_id: null,
};

const pokemonBooster: CtBlueprint = {
  id: 105159,
  name: 'Base Set Booster',
  version: null,
  game_id: 5,
  expansion_id: 1472,
  image_url: 'https://cardtrader.com/uploads/blueprints/image/105159/preview_booster.jpg',
  editable_properties: [{ name: 'first_edition' }, { name: 'pokemon_language' }],
  card_market_ids: [271823],
  tcg_player_id: 138130,
  scryfall_id: null,
};

const BLUEPRINTS: Record<number, CtBlueprint[]> = {
  979: [magicSingle],
  1472: [pokemonAlakazam, pokemonBooster],
  1468: [],
  1473: [],
};

const ctx = (secrets: Record<string, string> = { token: 'live-token' }): CatalogCtx => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  secrets,
});

/** Serves the fixtures for the paths the source is expected to request. */
const stubFetch = (calls: string[] = []) =>
  vi.fn(async (url: string) => {
    calls.push(url);

    if (url.endsWith('/games')) return new Response(JSON.stringify({ array: GAMES }));
    if (url.endsWith('/expansions')) return new Response(JSON.stringify(EXPANSIONS));

    const match = /expansion_id=(\d+)/.exec(url);
    if (match) {
      const id = Number(match[1]);
      const body = BLUEPRINTS[id];
      if (body === undefined) return new Response('missing', { status: 404 });
      return new Response(JSON.stringify(body));
    }

    return new Response('missing', { status: 404 });
  });

const source = (fetchImpl: ReturnType<typeof stubFetch>) =>
  createCardTraderSource({
    fetch: fetchImpl as unknown as typeof fetch,
    baseUrl: 'https://x/api/v2',
  });

describe('createCardTraderSource', () => {
  it('is a valid CatalogSource', () => {
    expect(validateCatalogSource(createCardTraderSource())).toEqual([]);
  });

  it('declares the id namespaces it can supply and that it needs a token', () => {
    const s = createCardTraderSource();
    expect(s.providesExternalIds).toEqual(['tcgplayer', 'scryfall', 'cardmarket']);
    expect(s.secretFields).toEqual(['token']);
    expect(s.key).toBe('cardtrader');
  });
});

describe('authentication', () => {
  it('refuses to call the API at all without a token', async () => {
    const fetchImpl = stubFetch();
    const s = source(fetchImpl);

    await expect(s.search(ctx({}), { text: 'chandra', game: 'Magic' })).rejects.toThrow(
      /requires a token/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the token as a bearer header', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      if (url.endsWith('/games')) return new Response(JSON.stringify({ array: GAMES }));
      return new Response(JSON.stringify(EXPANSIONS));
    });

    await source(fetchImpl as unknown as ReturnType<typeof stubFetch>).search(
      ctx({ token: 'abc123' }),
      {
        text: 'nothing matches',
        game: 'Magic',
      },
    );

    expect(seen[0]?.Authorization).toBe('Bearer abc123');
  });
});

describe('search', () => {
  it('finds a card when narrowed to a game and set', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'chandra',
      game: 'Magic',
      setName: 'Core Set 2020',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('Chandra, Awakened Inferno');
    expect(results[0]?.externalIds.tcgplayer).toBe('192222');
  });

  it('accepts the display name of a game as well as the short one', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'chandra',
      game: 'Magic: the Gathering',
      setName: 'Core Set 2020',
    });
    expect(results).toHaveLength(1);
  });

  it('matches loosely against name or version', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'holo rare',
      game: 'Pokémon',
      setName: 'Base Set',
    });
    expect(results.map((r) => r.name)).toContain('Alakazam - Holo Rare | 1/102');
  });

  it('prefers an exactly named set over ones merely containing it', async () => {
    const calls: string[] = [];
    // "Base Set 2" (expansion 1473) contains "Base Set" as a substring, so
    // containment matching alone would download it too.
    await source(stubFetch(calls)).search(ctx(), {
      text: 'a',
      game: 'Pokémon',
      setName: 'Base Set',
    });

    expect(calls.some((u) => u.includes('expansion_id=1472'))).toBe(true);
    expect(calls.some((u) => u.includes('expansion_id=1473'))).toBe(false);
  });

  it('refuses to search more games than the limit without a game named', async () => {
    const s = createCardTraderSource({
      fetch: stubFetch() as unknown as typeof fetch,
      baseUrl: 'https://x/api/v2',
      maxGamesPerSearch: 1,
    });
    await expect(s.search(ctx(), { text: 'x' })).rejects.toThrow(/needs a game/i);
  });

  it('refuses when a set name matches more expansions than the download limit', async () => {
    const s = createCardTraderSource({
      fetch: stubFetch() as unknown as typeof fetch,
      baseUrl: 'https://x/api/v2',
      maxExpansionsPerSearch: 1,
    });
    // No setName narrows within Pokémon, so both its expansions match.
    await expect(s.search(ctx(), { text: 'x', game: 'Pokémon' })).rejects.toThrow(
      /above the limit/i,
    );
  });

  it('returns nothing for a game it has no match for, rather than throwing', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'x',
      game: 'Not A Real Game',
    });
    expect(results).toEqual([]);
  });

  it('returns nothing for empty text without making a request', async () => {
    const fetchImpl = stubFetch();
    const results = await source(fetchImpl).search(ctx(), { text: '   ' });
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours the caller limit', async () => {
    const results = await source(stubFetch()).search(ctx(), {
      text: 'e', // matches both Pokémon blueprints in Base Set
      game: 'Pokémon',
      setName: 'Base Set',
      limit: 1,
    });
    expect(results).toHaveLength(1);
  });

  it('caches games, expansions and blueprint downloads within the TTL', async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(calls);
    const s = source(fetchImpl);

    await s.search(ctx(), { text: 'chandra', game: 'Magic', setName: 'Core Set 2020' });
    await s.search(ctx(), { text: 'chandra', game: 'Magic', setName: 'Core Set 2020' });

    // /games, /expansions, and one expansion export — each requested once
    // across both calls, not once per call.
    expect(calls.filter((u) => u.endsWith('/games'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/expansions'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('expansion_id=979'))).toHaveLength(1);
  });

  it('reports a failed download rather than treating it as no results', async () => {
    const s = createCardTraderSource({
      fetch: (async () => new Response('error', { status: 502 })) as unknown as typeof fetch,
      baseUrl: 'https://x/api/v2',
    });
    await expect(s.search(ctx(), { text: 'x', game: 'Magic' })).rejects.toThrow(/502/);
  });
});

describe('listSets', () => {
  it('returns every expansion, narrowed to one game', async () => {
    const sets = await source(stubFetch()).listSets(ctx(), 'Pokémon');
    expect(sets.map((s) => s.name).sort()).toEqual([
      'Base Set',
      'Base Set 2',
      'Wizards of the Coast Era Promos',
    ]);
    expect(sets.every((s) => s.game === 'Pokémon')).toBe(true);
  });

  it('returns every expansion of every game when none is named', async () => {
    const sets = await source(stubFetch()).listSets(ctx());
    expect(sets).toHaveLength(EXPANSIONS.length);
  });
});

describe('fetchSet', () => {
  it('returns every blueprint in one expansion, mapped to candidates', async () => {
    const candidates = await source(stubFetch()).fetchSet(ctx(), '1472');
    expect(candidates.map((c) => c.sourceId).sort()).toEqual(['105159', '111148']);
    expect(candidates.every((c) => c.setName === 'Base Set')).toBe(true);
  });

  it('refuses a non-numeric set id', async () => {
    await expect(source(stubFetch()).fetchSet(ctx(), 'not-a-number')).rejects.toThrow(/numeric/i);
  });
});

describe('fetchById', () => {
  it('returns null for a blueprint whose expansion has never been read', async () => {
    const found = await source(stubFetch()).fetchById(ctx(), '111148');
    expect(found).toBeNull();
  });

  it('re-fetches a blueprint from an expansion that was searched', async () => {
    const s = source(stubFetch());
    await s.search(ctx(), { text: 'alakazam', game: 'Pokémon', setName: 'Base Set' });

    const found = await s.fetchById(ctx(), '111148');
    expect(found?.name).toBe('Alakazam - Holo Rare | 1/102');
  });

  it('indexes every blueprint in the expansion, not only the ones a search matched', async () => {
    const s = source(stubFetch());
    // Only matches the Alakazam row, but should still index the booster too.
    await s.search(ctx(), { text: 'alakazam', game: 'Pokémon', setName: 'Base Set' });

    const found = await s.fetchById(ctx(), '105159');
    expect(found?.name).toBe('Base Set Booster');
  });

  it('returns null for an empty id without touching the network', async () => {
    const fetchImpl = stubFetch();
    const found = await source(fetchImpl).fetchById(ctx(), '   ');
    expect(found).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
