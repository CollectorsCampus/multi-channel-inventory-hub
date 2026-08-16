import { describe, expect, it } from 'vitest';
import {
  normalizeForMatch,
  previewItemKind,
  previewTags,
  suggestChoice,
  suggestTag,
} from './tagSuggest';

/**
 * The values here are real: catalogue spellings from tcgcsv and tags from the
 * store this was built for.
 */

const STORE_TAGS = [
  'Pokémon',
  'Magic: The Gathering',
  'ME02 Phantasmal Flames',
  'SV04 Paradox Rift',
  'Elite Trainer Box',
  'Booster Pack',
];

describe('normalizeForMatch', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalizeForMatch('Pokémon')).toBe(normalizeForMatch('Pokemon'));
    expect(normalizeForMatch('ME02: Phantasmal Flames')).toBe(
      normalizeForMatch('ME02 Phantasmal Flames'),
    );
    expect(normalizeForMatch('Magic: The Gathering')).toBe(
      normalizeForMatch('magic the gathering'),
    );
  });

  it('does not collapse genuinely different names', () => {
    expect(normalizeForMatch('SV085 Prismatic Evolutions')).not.toBe(
      normalizeForMatch('SV85 Prismatic Evolutions'),
    );
  });
});

describe('suggestTag', () => {
  it('finds the store spelling of a game', () => {
    expect(suggestTag('Pokemon', STORE_TAGS)).toBe('Pokémon');
    expect(suggestTag('Magic', STORE_TAGS)).toBeNull();
  });

  it('finds the store spelling of a set, which is usually a punctuation change', () => {
    expect(suggestTag('ME02: Phantasmal Flames', STORE_TAGS)).toBe('ME02 Phantasmal Flames');
    expect(suggestTag('SV04: Paradox Rift', STORE_TAGS)).toBe('SV04 Paradox Rift');
  });

  /**
   * The case the whole design exists to refuse. The operator's store carries
   * this set under two different tags, and neither is the catalogue's spelling
   * — so there is nothing to suggest and they choose.
   */
  it('suggests nothing for a set the store spells two ways', () => {
    const ambiguous = ['SV085 Prismatic Evolutions', 'SV85 Prismatic Evolutions'];
    expect(suggestTag('SV: Prismatic Evolutions', ambiguous)).toBeNull();
  });

  /** Two tags that mean the same thing are two real collections, not a tie. */
  it('suggests nothing when more than one tag normalises the same way', () => {
    expect(suggestTag('Pokemon', ['Pokémon', 'POKEMON'])).toBeNull();
  });

  it('suggests nothing when the store has no such tag', () => {
    expect(suggestTag('Flesh and Blood', STORE_TAGS)).toBeNull();
    expect(suggestTag('Pokemon', [])).toBeNull();
  });

  it('handles an empty or punctuation-only value', () => {
    expect(suggestTag('', STORE_TAGS)).toBeNull();
    expect(suggestTag(' : - ', STORE_TAGS)).toBeNull();
  });

  it('returns the exact tag when it is already exact', () => {
    expect(suggestTag('Elite Trainer Box', STORE_TAGS)).toBe('Elite Trainer Box');
  });
});

describe('suggestChoice', () => {
  /**
   * Metaobject entries as the store really spells them: the operator's
   * `custom.set` uses the tag spelling, not the catalogue's `ME02: Phantasmal
   * Flames`, which is why matching by label rather than by equality is what
   * makes this useful at all.
   */
  const GAMES = [
    { value: 'gid://shopify/Metaobject/1', label: 'Pokémon' },
    { value: 'gid://shopify/Metaobject/2', label: 'Magic: The Gathering' },
  ];
  const SETS = [
    { value: 'gid://shopify/Metaobject/9', label: 'ME02 Phantasmal Flames' },
    { value: 'gid://shopify/Metaobject/10', label: 'SV04 Paradox Rift' },
  ];

  it('finds the entry for a catalogue game or set name', () => {
    expect(suggestChoice('Pokemon', GAMES)?.value).toBe('gid://shopify/Metaobject/1');
    expect(suggestChoice('ME02: Phantasmal Flames', SETS)?.value).toBe(
      'gid://shopify/Metaobject/9',
    );
  });

  /**
   * What makes offering every field against every value safe rather than a
   * shotgun: a set name finds nothing among the games, so only the pairings
   * that could be right are ever proposed.
   */
  it('finds nothing for a value belonging to a different field', () => {
    expect(suggestChoice('ME02: Phantasmal Flames', GAMES)).toBeNull();
    expect(suggestChoice('Pokemon', SETS)).toBeNull();
  });

  /** Ambiguity is not a tie to break — two entries are two real records. */
  it('refuses when two entries normalise the same way', () => {
    expect(
      suggestChoice('Pokemon', [
        { value: 'a', label: 'Pokémon' },
        { value: 'b', label: 'POKEMON' },
      ]),
    ).toBeNull();
  });

  it('handles an empty value and an empty vocabulary', () => {
    expect(suggestChoice('', GAMES)).toBeNull();
    expect(suggestChoice('Pokemon', [])).toBeNull();
  });
});

/**
 * These mirror `itemKind` and `resolveTags` on the API, which are
 * authoritative. The mirror exists so the intake screen can say what will
 * happen while the card is still on screen; these tests are what stop the two
 * drifting far enough to be misleading.
 */
describe('previewItemKind', () => {
  it('agrees with the server on all three', () => {
    expect(previewItemKind('NM')).toBe('single');
    expect(previewItemKind('SEALED')).toBe('sealed');
    expect(previewItemKind('NA')).toBe('other');
  });
});

describe('previewTags with a kind rule', () => {
  const rules = [
    { match: 'kind' as const, value: 'single', tag: 'Singles' },
    { match: 'game' as const, value: 'Pokemon', tag: 'Pokémon' },
  ];
  const card = { name: 'Mega Charizard X ex', game: 'Pokemon', setName: 'ME02' };

  it('previews the singles tag for a card and withholds it for a box', () => {
    expect(previewTags(rules, [], { ...card, condition: 'NM' })).toEqual(['Singles', 'Pokémon']);
    expect(previewTags(rules, [], { ...card, condition: 'SEALED' })).toEqual(['Pokémon']);
  });

  it('withholds it when the condition is unknown, as the server does', () => {
    expect(previewTags(rules, [], card)).toEqual(['Pokémon']);
  });
});
