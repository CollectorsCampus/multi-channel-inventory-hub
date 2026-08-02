import { describe, expect, it } from 'vitest';
import type { ListingMetafield } from '@hub/connector-sdk';
import {
  applyListingDefaults,
  encodeListingDefaults,
  hasDeclaredDefaults,
  parseListingDefaults,
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
    const stored = encodeListingDefaults({
      tags: ['Pokémon', 'SV04 Paradox Rift'],
      metafields: [gameField],
      category: 'ae-2-2-3-2',
      vendor: 'The Pokémon Company',
    });

    expect(parseListingDefaults(stored)).toEqual({
      tags: ['Pokémon', 'SV04 Paradox Rift'],
      metafields: [gameField],
      category: 'ae-2-2-3-2',
      vendor: 'The Pokémon Company',
    });
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
    tags: ['Pokémon'],
    metafields: [gameField],
    category: 'ae-2-2-3-2',
    vendor: 'The Pokémon Company',
  };

  it('fills in every field the caller omitted', () => {
    expect(applyListingDefaults({}, defaults)).toEqual(defaults);
  });

  it('never overrides what the caller asked for', () => {
    const request = {
      tags: ['Magic: The Gathering'],
      metafields: [],
      category: 'other',
      vendor: 'Wizards of the Coast',
    };
    expect(applyListingDefaults(request, defaults)).toEqual(request);
  });

  /**
   * An override, not a gap. A run that says "no tags" must reach the channel
   * saying no tags — silently refilling it from the channel would make the
   * per-run choice unexpressible.
   */
  it('treats an explicitly empty list as an answer, not an omission', () => {
    expect(applyListingDefaults({ tags: [] }, defaults).tags).toEqual([]);
  });

  it('leaves unrelated request fields alone', () => {
    const request = { inventoryItemIds: ['a', 'b'], tags: undefined };
    expect(applyListingDefaults(request, { tags: ['Pokémon'] })).toEqual({
      inventoryItemIds: ['a', 'b'],
      tags: ['Pokémon'],
    });
  });

  it('changes nothing when the channel has declared nothing', () => {
    const request = { tags: ['Pokémon'] };
    expect(applyListingDefaults(request, {})).toEqual(request);
  });
});
