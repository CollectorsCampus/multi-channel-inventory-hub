import { describe, expect, it } from 'vitest';
import { toCandidate, toCandidates, type CtBlueprint } from './blueprints';

/**
 * Modelled on real `/blueprints/export` responses read 2026-08-03 (Core Set
 * 2020 / expansion 979, and Pokémon Base Set / expansion 1472) — not scraped
 * text, but the same field shapes and the same real ids.
 */
const magicSingle: CtBlueprint = {
  id: 57957,
  name: 'Chandra, Awakened Inferno',
  version: null,
  game_id: 1,
  expansion_id: 979,
  image_url: 'https://cardtrader.com/uploads/blueprints/image/57957/preview_chandra.jpg',
  editable_properties: [{ name: 'condition' }, { name: 'mtg_language' }, { name: 'mtg_foil' }],
  card_market_ids: [377187],
  tcg_player_id: 192222,
  scryfall_id: '49d2a680-4f3b-4bfa-b77b-d2dfaced9f23',
};

const pokemonSingleWithVersion: CtBlueprint = {
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

const pokemonSealed: CtBlueprint = {
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

const lookup = {
  gameName: (id: number) => ({ 1: 'Magic', 5: 'Pokémon' })[id],
  expansionName: (id: number) => ({ 979: 'Core Set 2020', 1472: 'Base Set' })[id],
};

describe('toCandidate', () => {
  it('carries every id namespace a blueprint publishes', () => {
    const candidate = toCandidate(magicSingle);
    expect(candidate.externalIds).toEqual({
      cardtrader: '57957',
      tcgplayer: '192222',
      scryfall: '49d2a680-4f3b-4bfa-b77b-d2dfaced9f23',
      cardmarket: '377187',
    });
  });

  it('folds `version` into the name, the way tcgcsv folds a collector number in', () => {
    const candidate = toCandidate(pokemonSingleWithVersion);
    expect(candidate.name).toBe('Alakazam - Holo Rare | 1/102');
  });

  it('leaves the name alone when there is no version', () => {
    const candidate = toCandidate(magicSingle);
    expect(candidate.name).toBe('Chandra, Awakened Inferno');
  });

  it('resolves game and set through the supplied lookup', () => {
    const candidate = toCandidate(magicSingle, lookup);
    expect(candidate.game).toBe('Magic');
    expect(candidate.setName).toBe('Core Set 2020');
  });

  it('omits game and set when the lookup cannot resolve them', () => {
    const candidate = toCandidate(magicSingle);
    expect(candidate.game).toBeUndefined();
    expect(candidate.setName).toBeUndefined();
  });

  it('omits ids a blueprint does not publish, rather than writing empty strings', () => {
    const candidate = toCandidate(pokemonSealed);
    expect(candidate.externalIds).toEqual({
      cardtrader: '105159',
      tcgplayer: '138130',
      cardmarket: '271823',
    });
    expect('scryfall' in candidate.externalIds).toBe(false);
  });

  it('never sets marketPrice: blueprints carry no price at all', () => {
    expect(toCandidate(magicSingle).marketPrice).toBeUndefined();
  });

  it('never sets printings: there is no shared finish vocabulary to guess from', () => {
    expect(toCandidate(magicSingle).printings).toBeUndefined();
  });

  it('takes only the first cardmarket id when a blueprint publishes several', () => {
    const multi: CtBlueprint = { ...magicSingle, card_market_ids: [111, 222] };
    expect(toCandidate(multi).externalIds.cardmarket).toBe('111');
  });

  it('handles a blueprint with no cardmarket ids at all', () => {
    const none: CtBlueprint = { ...magicSingle, card_market_ids: null };
    expect('cardmarket' in toCandidate(none).externalIds).toBe(false);
  });
});

describe('toCandidates', () => {
  it('maps one blueprint to one candidate, never grouping', () => {
    const candidates = toCandidates([magicSingle, pokemonSingleWithVersion], lookup);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.sourceId)).toEqual(['57957', '111148']);
  });
});
