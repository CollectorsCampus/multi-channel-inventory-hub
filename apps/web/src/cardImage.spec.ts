import { describe, expect, it } from 'vitest';
import { enlargedImageUrl } from './cardImage';

/**
 * The URLs here are real ones taken from the catalogue, and the enlarged forms
 * were checked against the live CDNs — most of the plausible alternatives 403,
 * so this is a known grammar rather than a rule.
 */

const TCG_THUMB = 'https://tcgplayer-cdn.tcgplayer.com/product/565630_200w.jpg';
const SCRYFALL_NORMAL =
  'https://cards.scryfall.io/normal/front/b/9/b9203f23-8c7a-47e1-b359-5a326722d1c0.jpg?1783938899';

describe('enlargedImageUrl', () => {
  it('upgrades a TCGPlayer thumbnail to the size that exists', () => {
    expect(enlargedImageUrl(TCG_THUMB)).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/product/565630_in_1000x1000.jpg',
    );
  });

  it('upgrades any TCGPlayer width, not just the one the catalogue happens to store', () => {
    expect(enlargedImageUrl('https://tcgplayer-cdn.tcgplayer.com/product/1_400w.jpg')).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/product/1_in_1000x1000.jpg',
    );
  });

  it('upgrades Scryfall to large, keeping the cache-busting query', () => {
    const enlarged = enlargedImageUrl(SCRYFALL_NORMAL);
    expect(enlarged).toBe(
      'https://cards.scryfall.io/large/front/b/9/b9203f23-8c7a-47e1-b359-5a326722d1c0.jpg?1783938899',
    );
  });

  it('upgrades Scryfall small as well as normal', () => {
    expect(enlargedImageUrl('https://cards.scryfall.io/small/front/a/b/x.jpg')).toBe(
      'https://cards.scryfall.io/large/front/a/b/x.jpg',
    );
  });

  /**
   * The size is the first path segment, so it is replaced positionally. A
   * substring swap would also rewrite an id that happened to contain the word.
   */
  it('does not rewrite a size word appearing inside the path', () => {
    expect(
      enlargedImageUrl('https://cards.scryfall.io/large/front/n/o/normal-card.jpg'),
    ).toBeNull();
  });

  /**
   * Null is the honest answer for "no larger version is known", and the caller
   * treats it as "show the stored one bigger". Guessing here is what would
   * produce a broken image.
   */
  it.each([
    ['an unknown host', 'https://example.test/product/1_200w.jpg'],
    ['a TCGPlayer URL with no width suffix', 'https://tcgplayer-cdn.tcgplayer.com/product/1.jpg'],
    ['a Scryfall URL already at large', 'https://cards.scryfall.io/large/front/a/b/x.jpg'],
    ['a relative path', '/images/card.jpg'],
    ['nonsense', 'not a url'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, url) => {
    expect(enlargedImageUrl(url)).toBeNull();
  });

  it('returns null rather than throwing for a missing value', () => {
    expect(enlargedImageUrl(null)).toBeNull();
    expect(enlargedImageUrl(undefined)).toBeNull();
  });

  /**
   * A lookalike path on another host must not match — which is why the host is
   * compared exactly rather than with `includes`.
   */
  it('does not match a host that merely contains a known one', () => {
    expect(enlargedImageUrl('https://cards.scryfall.io.evil.test/normal/a/b/x.jpg')).toBeNull();
    expect(
      enlargedImageUrl('https://tcgplayer-cdn.tcgplayer.com.evil.test/product/1_200w.jpg'),
    ).toBeNull();
  });
});
