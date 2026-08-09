import { describe, expect, it } from 'vitest';
import type { ListingMetafield } from '@hub/connector-sdk';
import {
  applyListingDefaults,
  encodeListingDefaults,
  hasDeclaredDefaults,
  itemKind,
  parseListingDefaults,
  resolveMetafields,
  resolveTags,
  resolveVendor,
  type ChannelListingDefaults,
} from './listing-defaults';

const gameField: ListingMetafield = {
  owner: 'product',
  namespace: 'custom',
  key: 'game',
  type: 'metaobject_reference',
  value: 'gid://shopify/Metaobject/141624803381',
};

describe('parseListingDefaults', () => {
  it('reads a full declaration back unchanged', () => {
    const full: ChannelListingDefaults = {
      tags: ['Pokémon', 'SV04 Paradox Rift'],
      tagRules: [{ match: 'kind', value: 'single', tag: 'Singles' }],
      metafields: [gameField],
      metafieldRules: [{ match: 'game', value: 'Pokemon', metafield: gameField }],
      category: 'ae-2-2-3-2',
      vendor: 'The Pokémon Company',
      vendorRules: [{ match: 'game', value: 'Gundam Card Game', vendor: 'Bandai Card Games' }],
      publications: ['gid://shopify/Publication/150470950965'],
    };

    expect(parseListingDefaults(encodeListingDefaults(full))).toEqual(full);
  });

  it('treats an empty column, malformed JSON and a non-object alike', () => {
    for (const raw of ['', '{', 'null', '[]', '"tags"', null, undefined]) {
      expect(parseListingDefaults(raw)).toEqual({});
    }
  });

  /**
   * The distinction the whole design rests on: "no tags" is an answer, and it
   * must survive storage. If it collapsed to absent, a run would silently
   * inherit tags the operator had deliberately cleared.
   */
  it('keeps an explicitly empty tag list distinct from an absent one', () => {
    expect(parseListingDefaults(encodeListingDefaults({ tags: [] })).tags).toEqual([]);
    expect(parseListingDefaults(encodeListingDefaults({})).tags).toBeUndefined();
  });

  it('drops blank and non-string tags rather than sending them to a storefront', () => {
    expect(parseListingDefaults('{"tags":["Pokémon","",7,null,"Sealed"]}').tags).toEqual([
      'Pokémon',
      'Sealed',
    ]);
  });

  it.each([
    ['a bad owner', { ...gameField, owner: 'shop' }],
    ['no namespace', { ...gameField, namespace: '' }],
    ['no key', { ...gameField, key: '' }],
    ['no type', { ...gameField, type: '' }],
    ['a non-string value', { ...gameField, value: 12 }],
    ['not an object', 'custom.game'],
  ])('drops a metafield with %s', (_label, bad) => {
    const raw = JSON.stringify({ metafields: [bad, gameField] });
    expect(parseListingDefaults(raw).metafields).toEqual([gameField]);
  });

  it('ignores keys it does not know', () => {
    const raw = '{"tags":["Pokémon"],"status":"ACTIVE","published":true}';
    expect(parseListingDefaults(raw)).toEqual({ tags: ['Pokémon'] });
  });

  it('drops an empty category or vendor, which mean nothing to a channel', () => {
    expect(parseListingDefaults('{"category":"","vendor":""}')).toEqual({});
  });
});

describe('hasDeclaredDefaults', () => {
  it('is false when nothing has ever been declared', () => {
    expect(hasDeclaredDefaults({})).toBe(false);
    expect(hasDeclaredDefaults(parseListingDefaults('{}'))).toBe(false);
  });

  /**
   * Deliberately not "has tags". Requiring tags would be the hub deciding every
   * store organises by tag; refusing an undeclared channel is the thing that
   * actually stops untagged drafts appearing at the speed of intake.
   */
  it('is true once the operator has answered, including answering "none"', () => {
    expect(hasDeclaredDefaults({ tags: [] })).toBe(true);
    expect(hasDeclaredDefaults({ vendor: 'Wizards of the Coast' })).toBe(true);
    expect(hasDeclaredDefaults({ category: 'ae-2-2-3-2' })).toBe(true);
    expect(hasDeclaredDefaults({ metafields: [] })).toBe(true);
  });
});

describe('applyListingDefaults', () => {
  const defaults: ChannelListingDefaults = {
    category: 'ae-2-2-3-2',
    publications: ['gid://shopify/Publication/1', 'gid://shopify/Publication/2'],
  };

  it('fills in the run-level fields the caller omitted', () => {
    expect(applyListingDefaults({}, defaults)).toEqual(defaults);
  });

  it('never overrides what the caller asked for', () => {
    const request = { category: 'other', publications: ['gid://shopify/Publication/9'] };
    expect(applyListingDefaults(request, defaults)).toEqual(request);
  });

  /**
   * An override, not a gap. A run that says "publish nowhere" must reach the
   * channel saying none — silently refilling would make the per-run choice
   * unexpressible.
   */
  it('treats an explicitly empty publications list as an answer, not an omission', () => {
    expect(applyListingDefaults({ publications: [] }, defaults).publications).toEqual([]);
  });

  it('leaves unrelated request fields alone', () => {
    const request = { inventoryItemIds: ['a', 'b'], category: undefined };
    expect(applyListingDefaults(request, { category: 'ae-2-2-3-2' })).toEqual({
      inventoryItemIds: ['a', 'b'],
      category: 'ae-2-2-3-2',
    });
  });

  it('changes nothing when the channel has declared nothing', () => {
    const request = { category: 'ae-2-2-3-2' };
    expect(applyListingDefaults(request, {})).toEqual(request);
  });

  /**
   * The per-card fields depend on which card is being created, so they are
   * resolved per item rather than once per run. Filling them in here would pick
   * one answer for a whole batch, which is the bug this design replaced.
   */
  it('does not touch the per-card fields (tags, vendor, metafields)', () => {
    expect(
      applyListingDefaults(
        {},
        { tags: ['Pokémon'], vendor: 'The Pokémon Company', metafields: [gameField] },
      ),
    ).toEqual({});
  });
});

/**
 * Vendor by game — Pokémon is "The Pokémon Company", Gundam and One Piece are
 * "Bandai Card Games". First match wins because a product has one vendor.
 */
describe('resolveVendor', () => {
  const defaults: ChannelListingDefaults = {
    vendor: 'House Vendor',
    vendorRules: [
      { match: 'game', value: 'Pokemon', vendor: 'The Pokémon Company' },
      { match: 'game', value: 'One Piece Card Game', vendor: 'Bandai Card Games' },
    ],
  };

  it('takes the matching rule over the flat vendor', () => {
    expect(resolveVendor(defaults, { name: 'x', game: 'Pokemon' })).toBe('The Pokémon Company');
    expect(resolveVendor(defaults, { name: 'x', game: 'One Piece Card Game' })).toBe(
      'Bandai Card Games',
    );
  });

  it('falls back to the flat vendor when no rule matches', () => {
    expect(resolveVendor(defaults, { name: 'x', game: 'Magic' })).toBe('House Vendor');
  });

  it('is undefined when neither a rule nor a flat vendor is set', () => {
    expect(resolveVendor({ vendorRules: [] }, { name: 'x', game: 'Magic' })).toBeUndefined();
    expect(resolveVendor({}, { name: 'x' })).toBeUndefined();
  });

  it('takes the first matching rule, in operator order', () => {
    const two: ChannelListingDefaults = {
      vendorRules: [
        { match: 'game', value: 'Pokemon', vendor: 'First' },
        { match: 'name-contains', value: 'Charizard', vendor: 'Second' },
      ],
    };
    expect(resolveVendor(two, { name: 'Charizard ex', game: 'Pokemon' })).toBe('First');
  });
});

/**
 * `custom.game` varies by game, `custom.set` by set — the metafield counterpart
 * of the tag design, so a mixed batch gets the right metaobject per card.
 */
describe('resolveMetafields', () => {
  const setField: ListingMetafield = {
    owner: 'product',
    namespace: 'custom',
    key: 'set',
    type: 'metaobject_reference',
    value: 'gid://shopify/Metaobject/140043780149',
  };

  const defaults: ChannelListingDefaults = {
    metafieldRules: [
      { match: 'game', value: 'Pokemon', metafield: gameField },
      { match: 'set', value: 'ME02: Phantasmal Flames', metafield: setField },
    ],
  };

  it('accumulates every matching rule', () => {
    expect(
      resolveMetafields(defaults, {
        name: 'Charizard ex',
        game: 'Pokemon',
        setName: 'ME02: Phantasmal Flames',
      }),
    ).toEqual([gameField, setField]);
  });

  it('gives a different set a different metaobject, and no game field off-game', () => {
    expect(
      resolveMetafields(defaults, { name: 'Lightning Bolt', game: 'Magic', setName: 'Masters 25' }),
    ).toEqual([]);
  });

  it('applies unconditional metafields to everything, before the matched ones', () => {
    const withAlways: ChannelListingDefaults = { ...defaults, metafields: [setField] };
    // Deduped on (owner,namespace,key): the ME02 rule overrides the
    // unconditional custom.set rather than sending two values for one field.
    const resolved = resolveMetafields(withAlways, {
      name: 'x',
      game: 'Pokemon',
      setName: 'ME02: Phantasmal Flames',
    });
    expect(resolved).toEqual([setField, gameField]);
  });

  it('is empty when nothing matches or is configured', () => {
    expect(resolveMetafields({}, { name: 'x', game: 'Pokemon' })).toEqual([]);
  });
});

/**
 * The heart of the tag design.
 *
 * A store's tags are `Pokémon`, `SV04 Paradox Rift` and `Elite Trainer Box` —
 * every one varies per card — so one list per channel can only ever be right
 * for a single-game, single-set batch. Rules map facts the ledger already holds
 * onto tags the operator chose, which keeps "the hub never derives a tag" while
 * letting a mixed batch come out correct.
 */
describe('resolveTags', () => {
  const defaults: ChannelListingDefaults = {
    tagRules: [
      { match: 'game', value: 'Pokemon', tag: 'Pokémon' },
      { match: 'game', value: 'Magic', tag: 'Magic: The Gathering' },
      { match: 'set', value: 'ME02: Phantasmal Flames', tag: 'ME02 Phantasmal Flames' },
      { match: 'name-contains', value: 'Elite Trainer Box', tag: 'Elite Trainer Box' },
    ],
  };

  const etb = {
    name: 'Phantasmal Flames Elite Trainer Box',
    game: 'Pokemon',
    setName: 'ME02: Phantasmal Flames',
  };

  it('gives a card every tag whose rule matches', () => {
    expect(resolveTags(defaults, etb)).toEqual([
      'Pokémon',
      'ME02 Phantasmal Flames',
      'Elite Trainer Box',
    ]);
  });

  /** The whole point: two cards in one batch get different, correct tags. */
  it('gives a different card a different set', () => {
    expect(
      resolveTags(defaults, { name: 'Lightning Bolt', game: 'Magic', setName: 'Masters 25' }),
    ).toEqual(['Magic: The Gathering']);
  });

  it('applies unconditional tags to everything, before the matched ones', () => {
    const withAlways = { ...defaults, tags: ['Trading Cards'] };
    expect(resolveTags(withAlways, etb)[0]).toBe('Trading Cards');
    expect(resolveTags(withAlways, { name: 'Anything' })).toEqual(['Trading Cards']);
  });

  /**
   * Exact, because the value is picked from what the catalogue stores rather
   * than typed. A near miss must produce no tag rather than a wrong one — an
   * untagged product is findable in the admin, a mis-tagged one is in somebody
   * else's collection.
   */
  it('matches game and set exactly', () => {
    expect(resolveTags(defaults, { name: 'x', game: 'pokemon' })).toEqual([]);
    expect(resolveTags(defaults, { name: 'x', setName: 'ME02 Phantasmal Flames' })).toEqual([]);
  });

  /** Typed by hand, and a seller's capitalisation of "booster box" varies. */
  it('matches a name substring case-insensitively', () => {
    expect(resolveTags(defaults, { name: 'PHANTASMAL FLAMES ELITE TRAINER BOX' })).toEqual([
      'Elite Trainer Box',
    ]);
  });

  it('tolerates a card with no game or set', () => {
    expect(resolveTags(defaults, { name: 'Dragon Shield Sleeves' })).toEqual([]);
    expect(resolveTags(defaults, { name: 'x', game: null, setName: null })).toEqual([]);
  });

  /**
   * Two rules arriving at the same tag is a configuration worth tolerating —
   * a game rule and a name rule both saying `Pokémon` is an easy thing to set
   * up and means no harm.
   */
  it('does not repeat a tag two rules agree on', () => {
    const duplicated: ChannelListingDefaults = {
      tags: ['Pokémon'],
      tagRules: [
        { match: 'game', value: 'Pokemon', tag: 'Pokémon' },
        { match: 'name-contains', value: 'Elite', tag: 'Pokémon' },
      ],
    };
    expect(resolveTags(duplicated, etb)).toEqual(['Pokémon']);
  });

  it('is empty when nothing is configured', () => {
    expect(resolveTags({}, etb)).toEqual([]);
  });
});

describe('tag rules survive storage', () => {
  it('round-trips', () => {
    const rules: ChannelListingDefaults = {
      tagRules: [{ match: 'set', value: 'ME02: Phantasmal Flames', tag: 'ME02 Phantasmal Flames' }],
    };
    expect(parseListingDefaults(encodeListingDefaults(rules))).toEqual(rules);
  });

  it.each([
    ['an unknown match kind', { match: 'rarity', value: 'Rare', tag: 'Rare' }],
    ['no value', { match: 'game', value: '  ', tag: 'Pokémon' }],
    ['no tag', { match: 'game', value: 'Pokemon', tag: '' }],
    ['not an object', 'game=Pokemon'],
  ])('drops a rule with %s', (_label, bad) => {
    const good = { match: 'game', value: 'Pokemon', tag: 'Pokémon' };
    const raw = JSON.stringify({ tagRules: [bad, good] });
    expect(parseListingDefaults(raw).tagRules).toEqual([good]);
  });

  it('trims stored values, so a stray space cannot stop a rule matching', () => {
    const raw = '{"tagRules":[{"match":"game","value":" Pokemon ","tag":" Pokémon "}]}';
    expect(parseListingDefaults(raw).tagRules).toEqual([
      { match: 'game', value: 'Pokemon', tag: 'Pokémon' },
    ]);
  });

  /** Rules alone are a real declaration — they are the usual way to configure this. */
  it('counts as having declared defaults', () => {
    expect(
      hasDeclaredDefaults({ tagRules: [{ match: 'game', value: 'Pokemon', tag: 'Pokémon' }] }),
    ).toBe(true);
  });
});

describe('itemKind', () => {
  it('calls a real card condition a single', () => {
    for (const condition of ['NM', 'LP', 'MP', 'HP', 'DMG', 'M']) {
      expect(itemKind(condition)).toBe('single');
    }
  });

  it('separates sealed from "not applicable"', () => {
    // Two facts, not one. Collapsing them would let a rule tagging sealed
    // product file a playmat with the booster boxes.
    expect(itemKind('SEALED')).toBe('sealed');
    expect(itemKind('NA')).toBe('other');
  });
});

describe('kind tag rules', () => {
  const singles: ChannelListingDefaults = {
    tagRules: [
      { match: 'kind', value: 'single', tag: 'Singles' },
      { match: 'kind', value: 'sealed', tag: 'Sealed Product' },
    ],
  };

  const card = { name: 'Mega Charizard X ex', game: 'Pokemon', setName: 'ME02' };

  it('tags a card a single and a box sealed', () => {
    expect(resolveTags(singles, { ...card, condition: 'NM' })).toEqual(['Singles']);
    expect(resolveTags(singles, { ...card, condition: 'SEALED' })).toEqual(['Sealed Product']);
  });

  it('leaves an NA item alone when no rule covers it', () => {
    // A playmat is neither, and must not fall into either bucket.
    expect(resolveTags(singles, { name: 'Playmat', condition: 'NA' })).toEqual([]);
  });

  it('matches nothing when the condition is not known', () => {
    // The failure that matters: assuming `single` would tag every sealed box
    // on a channel whose only rule is "Singles".
    expect(resolveTags(singles, card)).toEqual([]);
    expect(resolveTags(singles, { ...card, condition: null })).toEqual([]);
  });

  it('combines with the other rule kinds', () => {
    const both: ChannelListingDefaults = {
      tagRules: [
        { match: 'game', value: 'Pokemon', tag: 'Pokémon' },
        { match: 'kind', value: 'single', tag: 'Singles' },
      ],
    };
    expect(resolveTags(both, { ...card, condition: 'LP' })).toEqual(['Pokémon', 'Singles']);
    expect(resolveTags(both, { ...card, condition: 'SEALED' })).toEqual(['Pokémon']);
  });

  it('drops a rule whose kind is not one this code knows', () => {
    // Dropped rather than defaulted: a rule that looks saved and silently
    // never fires is better than one that fires on the wrong things.
    const parsed = parseListingDefaults(
      JSON.stringify({
        tagRules: [
          { match: 'kind', value: 'singles', tag: 'Singles' },
          { match: 'kind', value: 'single', tag: 'Singles' },
        ],
      }),
    );
    expect(parsed.tagRules).toEqual([{ match: 'kind', value: 'single', tag: 'Singles' }]);
  });

  it('round-trips through storage', () => {
    expect(parseListingDefaults(encodeListingDefaults(singles))).toEqual(singles);
  });
});

describe('vendor rules survive storage', () => {
  it('round-trips', () => {
    const rules: ChannelListingDefaults = {
      vendorRules: [{ match: 'game', value: 'Pokemon', vendor: 'The Pokémon Company' }],
    };
    expect(parseListingDefaults(encodeListingDefaults(rules))).toEqual(rules);
  });

  it.each([
    ['an unknown match kind', { match: 'rarity', value: 'Rare', vendor: 'X' }],
    ['no value', { match: 'game', value: '  ', vendor: 'X' }],
    ['no vendor', { match: 'game', value: 'Pokemon', vendor: '' }],
    ['not an object', 'game=Pokemon'],
  ])('drops a vendor rule with %s', (_label, bad) => {
    const good = { match: 'game', value: 'Pokemon', vendor: 'The Pokémon Company' };
    const raw = JSON.stringify({ vendorRules: [bad, good] });
    expect(parseListingDefaults(raw).vendorRules).toEqual([good]);
  });

  it('counts as having declared defaults', () => {
    expect(
      hasDeclaredDefaults({ vendorRules: [{ match: 'game', value: 'Pokemon', vendor: 'X' }] }),
    ).toBe(true);
  });
});

describe('metafield rules survive storage', () => {
  const gameRule = { match: 'game' as const, value: 'Pokemon', metafield: gameField };

  it('round-trips', () => {
    const rules: ChannelListingDefaults = { metafieldRules: [gameRule] };
    expect(parseListingDefaults(encodeListingDefaults(rules))).toEqual(rules);
  });

  it.each([
    ['an unknown match kind', { match: 'rarity', value: 'Rare', metafield: gameField }],
    ['no value', { match: 'game', value: '  ', metafield: gameField }],
    ['a malformed metafield', { match: 'game', value: 'Pokemon', metafield: { key: 'game' } }],
    ['no metafield', { match: 'game', value: 'Pokemon' }],
  ])('drops a metafield rule with %s', (_label, bad) => {
    const raw = JSON.stringify({ metafieldRules: [bad, gameRule] });
    expect(parseListingDefaults(raw).metafieldRules).toEqual([gameRule]);
  });

  it('counts as having declared defaults', () => {
    expect(hasDeclaredDefaults({ metafieldRules: [gameRule] })).toBe(true);
  });
});

describe('publications survive storage', () => {
  it('round-trips and drops blank or non-string entries', () => {
    const raw =
      '{"publications":["gid://shopify/Publication/1","",7,null,"gid://shopify/Publication/2"]}';
    expect(parseListingDefaults(raw).publications).toEqual([
      'gid://shopify/Publication/1',
      'gid://shopify/Publication/2',
    ]);
  });

  /** "Publish nowhere" is an answer, and must survive storage distinct from absent. */
  it('keeps an explicitly empty list distinct from an absent one', () => {
    expect(parseListingDefaults(encodeListingDefaults({ publications: [] })).publications).toEqual(
      [],
    );
    expect(parseListingDefaults(encodeListingDefaults({})).publications).toBeUndefined();
  });

  it('counts as having declared defaults', () => {
    expect(hasDeclaredDefaults({ publications: [] })).toBe(true);
  });
});
