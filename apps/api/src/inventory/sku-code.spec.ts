import { describe, expect, it } from 'vitest';
import { encodeSkuCode, isSkuCode, parseSkuCode, type SkuCode } from './sku-code';

const NM: SkuCode = {
  sourceKey: 'tcgcsv',
  sourceId: '662182',
  condition: 'NM',
  printing: 'NORMAL',
  language: 'EN',
};

describe('encodeSkuCode', () => {
  it('renders the five segments in order', () => {
    expect(encodeSkuCode(NM)).toBe('tcgcsv:662182:NM:NORMAL:EN');
  });

  it('carries edition and finish in the one printing token', () => {
    // Edition has no segment of its own: `printing` already composes the two,
    // the way connector-tcgplayer's condition.ts does.
    expect(encodeSkuCode({ ...NM, printing: '1ST_EDITION_HOLOFOIL' })).toBe(
      'tcgcsv:662182:NM:1ST_EDITION_HOLOFOIL:EN',
    );
  });

  it('renders sealed product through the same format as a single', () => {
    // One format, one parser. Two would mean every reader has to guess which.
    expect(encodeSkuCode({ ...NM, sourceId: '704143', condition: 'SEALED' })).toBe(
      'tcgcsv:704143:SEALED:NORMAL:EN',
    );
  });

  it('handles a source whose ids are uuids rather than numbers', () => {
    expect(
      encodeSkuCode({
        ...NM,
        sourceKey: 'scryfall',
        sourceId: '56ebc372-aabd-4174-a943-c7bf59e5028d',
      }),
    ).toBe('scryfall:56ebc372-aabd-4174-a943-c7bf59e5028d:NM:NORMAL:EN');
  });

  /**
   * Every caller is about to write this into a live storefront, so a part that
   * would not parse back is refused rather than tidied. A listing stamped with
   * an unresolvable identifier survives until a human notices.
   */
  describe('refuses anything it could not read back', () => {
    it.each([
      ['a separator inside a part', { ...NM, sourceId: '662:182' }],
      ['an empty part', { ...NM, language: '' }],
      ['a lowercase condition', { ...NM, condition: 'nm' }],
      ['an upper-case source key', { ...NM, sourceKey: 'TCGCSV' }],
      ['whitespace', { ...NM, printing: 'NEAR MINT' }],
    ])('%s', (_label, parts) => {
      expect(() => encodeSkuCode(parts)).toThrow(/round-trip|Cannot build/);
    });

    it('names every bad part at once', () => {
      const message = (() => {
        try {
          encodeSkuCode({ ...NM, condition: 'nm', language: '' });
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      })();

      expect(message).toMatch(/condition/);
      expect(message).toMatch(/language/);
    });
  });
});

describe('parseSkuCode', () => {
  it('round-trips everything encode will produce', () => {
    for (const printing of ['NORMAL', 'HOLOFOIL', 'REVERSE_HOLOFOIL', '1ST_EDITION_HOLOFOIL']) {
      for (const condition of ['NM', 'LP', 'MP', 'HP', 'DMG', 'SEALED', 'NA']) {
        for (const language of ['EN', 'JP', 'DE']) {
          const parts = { ...NM, condition, printing, language };
          expect(parseSkuCode(encodeSkuCode(parts))).toEqual(parts);
        }
      }
    }
  });

  /**
   * The parser runs on every listing SKU in a real store. 434 of the operator's
   * 867 listings carry a seller SKU that has nothing to do with this hub, and
   * reading one of those as a code would report `certain` — the one tier
   * offered for bulk acceptance — on a guess.
   */
  describe('rejects the seller SKUs a real store actually holds', () => {
    it.each([
      '10-10050-122',
      '123-45678',
      'UGDSQR123456',
      'ULP12345',
      'PKU12345',
      '704143',
      '',
      'gid://shopify/ProductVariant/44820357251125',
    ])('%s', (value) => {
      expect(parseSkuCode(value)).toBeUndefined();
      expect(isSkuCode(value)).toBe(false);
    });
  });

  describe('rejects near-misses', () => {
    it.each([
      ['four segments', 'tcgcsv:662182:NM:NORMAL'],
      ['six segments', 'tcgcsv:662182:NM:NORMAL:EN:EXTRA'],
      ['an empty segment', 'tcgcsv::NM:NORMAL:EN'],
      ['a lowercase token', 'tcgcsv:662182:nm:NORMAL:EN'],
      ['an upper-case source key', 'TCGCSV:662182:NM:NORMAL:EN'],
      // Not trimmed: a code with whitespace round it is not one we wrote, and
      // accepting it would make writing and reading disagree about the value.
      ['surrounding whitespace', ' tcgcsv:662182:NM:NORMAL:EN '],
      ['a prototype-shaped source key', '__proto__:662182:NM:NORMAL:EN'],
    ])('%s', (_label, value) => {
      expect(parseSkuCode(value)).toBeUndefined();
    });
  });

  it('tolerates a missing value rather than throwing', () => {
    // Most listings have no SKU at all; that is not an error.
    expect(parseSkuCode(undefined)).toBeUndefined();
    expect(parseSkuCode(null)).toBeUndefined();
  });
});
