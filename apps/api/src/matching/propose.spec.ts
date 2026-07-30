import { describe, expect, it } from 'vitest';
import type { ChannelListing } from '@hub/connector-sdk';
import {
  deriveSkuDimensions,
  normalizeTitle,
  proposeMatch,
  proposeMatches,
  scoreCandidates,
  splitChannelTitle,
  summarize,
  type MatchTarget,
} from './propose';

/**
 * The judgement, tested without a database or a store.
 *
 * The property that matters most is not "does it find matches" but "does it
 * refuse to invent them". A wrong link points inventory at the wrong listing, so
 * the next sale decrements the wrong SKU and the mistake surfaces days later as
 * drift nobody can explain.
 */

const listing = (overrides: Partial<ChannelListing> = {}): ChannelListing => ({
  externalListingId: 'gid://shopify/ProductVariant/1',
  title: 'Surging Sparks Elite Trainer Box',
  ...overrides,
});

const target = (overrides: Partial<MatchTarget> = {}): MatchTarget => ({
  id: 't1',
  name: 'Surging Sparks Elite Trainer Box',
  ...overrides,
});

describe('normalizeTitle', () => {
  it('ignores case and punctuation', () => {
    expect(normalizeTitle('U.S.S. Enterprise-D, Galaxy-Class')).toBe(
      'u s s enterprise d galaxy class',
    );
  });
});

describe('splitChannelTitle', () => {
  it('separates a condition qualifier from the product name', () => {
    expect(splitChannelTitle('Pikachu ex - Near Mint Foil')).toEqual({
      productName: 'Pikachu ex',
      qualifier: 'Near Mint Foil',
    });
  });

  /**
   * The dangerous case. Magic ships "Commander: Star Trek", and plenty of
   * products have a hyphen in the name — losing half the name to a hopeful split
   * would make every one of them unmatchable.
   */
  it('leaves a hyphenated product name alone when the tail is not a condition', () => {
    expect(splitChannelTitle('Star Trek - Play Booster Display')).toEqual({
      productName: 'Star Trek - Play Booster Display',
    });
    expect(splitChannelTitle('Commander - Star Trek')).toEqual({
      productName: 'Commander - Star Trek',
    });
  });

  it('handles a title with no separator at all', () => {
    expect(splitChannelTitle('Surging Sparks Elite Trainer Box')).toEqual({
      productName: 'Surging Sparks Elite Trainer Box',
    });
  });
});

describe('deriveSkuDimensions', () => {
  it('reads condition, printing and language from a variant title', () => {
    expect(deriveSkuDimensions(listing({ title: 'Pikachu ex - Near Mint Foil' }))).toEqual({
      condition: 'NM',
      printing: 'FOIL',
      language: 'EN',
    });
  });

  it('carries a language through rather than assuming English', () => {
    const derived = deriveSkuDimensions(
      listing({ title: 'Pikachu ex - Near Mint Holofoil - Japanese' }),
    );
    // Guessing English here is precisely how a Japanese card gets filed as an
    // English one, which is the mistake the condition parser exists to prevent.
    expect(derived?.language).toBe('JA');
  });

  it('returns nothing rather than defaulting to Near Mint', () => {
    // A sealed box has no condition in its title. Inventing one would have the
    // software decide what a card is worth on the operator's behalf.
    expect(
      deriveSkuDimensions(listing({ title: 'Surging Sparks Elite Trainer Box' })),
    ).toBeUndefined();
  });

  it('returns nothing for an unreadable qualifier instead of guessing', () => {
    expect(deriveSkuDimensions(listing({ title: 'Pikachu ex - Slightly Bent' }))).toBeUndefined();
  });
});

describe('evidence ranking', () => {
  it('treats an exact barcode as certain', () => {
    const [best] = scoreCandidates(listing({ barcode: '820650861234' }), [
      target({ barcode: '820650861234' }),
    ]);

    expect(best?.reason).toBe('barcode');
    expect(best?.confidence).toBe('certain');
  });

  it('treats a SKU equal to a platform id as certain', () => {
    const [best] = scoreCandidates(listing({ sku: '697344', title: 'Something Else Entirely' }), [
      target({ externalIds: { tcgplayer: '697344' } }),
    ]);

    expect(best?.reason).toBe('external-id');
    expect(best?.confidence).toBe('certain');
    expect(best?.detail).toContain('tcgplayer');
  });

  it('treats a SKU containing a platform id as probable, not certain', () => {
    const [best] = scoreCandidates(
      listing({ sku: 'PKM-697344-NM', title: 'Something Else Entirely' }),
      [target({ externalIds: { tcgplayer: '697344' } })],
    );

    // Embedded is good evidence but not proof — the surrounding text is unread.
    expect(best?.reason).toBe('external-id-embedded');
    expect(best?.confidence).toBe('probable');
  });

  it('does not match a short id that appears by coincidence', () => {
    // A two-digit id inside an unrelated code would match almost anything.
    const candidates = scoreCandidates(listing({ sku: 'BOX-1999-EDITION', title: 'Unrelated' }), [
      target({ name: 'Unrelated Other', externalIds: { tcgplayer: '99' } }),
    ]);

    expect(candidates.every((c) => c.reason !== 'external-id-embedded')).toBe(true);
  });

  it('ranks barcode above a name match on the same target set', () => {
    const candidates = scoreCandidates(listing({ barcode: '111' }), [
      target({ id: 'by-name' }),
      target({ id: 'by-barcode', name: 'Totally Different Name', barcode: '111' }),
    ]);

    expect(candidates[0]?.target.id).toBe('by-barcode');
    expect(candidates[0]?.confidence).toBe('certain');
  });

  it('rates a name-and-set agreement above a bare name agreement', () => {
    const withSet = scoreCandidates(listing(), [target({ setName: 'Surging Sparks' })]);
    const withoutSet = scoreCandidates(listing(), [target()]);

    expect(withSet[0]?.reason).toBe('name-and-set');
    expect(withSet[0]?.confidence).toBe('probable');
    expect(withoutSet[0]?.reason).toBe('name');
    expect(withoutSet[0]?.confidence).toBe('possible');
  });

  it('matches a name across punctuation differences', () => {
    const [best] = scoreCandidates(listing({ title: 'U.S.S. Enterprise-D, Galaxy-Class' }), [
      target({ name: 'USS Enterprise D Galaxy Class' }),
    ]);

    expect(best?.confidence).toBe('possible');
    expect(best?.reason).toBe('name');
  });

  it('ignores condition text when comparing names', () => {
    const [best] = scoreCandidates(listing({ title: 'Pikachu ex - Lightly Played Foil' }), [
      target({ name: 'Pikachu ex', setName: 'Surging Sparks' }),
    ]);

    // Without stripping the qualifier this finds nothing at all.
    expect(best?.reason).toBe('name-and-set');
  });

  it('offers no candidate for something unrelated', () => {
    expect(
      scoreCandidates(listing({ title: 'Playmat' }), [target({ name: 'Pikachu ex' })]),
    ).toEqual([]);
  });

  it('does not match on a name too short to mean anything', () => {
    const candidates = scoreCandidates(listing({ title: 'ex' }), [target({ name: 'Pikachu ex' })]);
    // "ex" is inside thousands of card names; a partial match on it is noise.
    expect(candidates).toEqual([]);
  });
});

describe('proposeMatch', () => {
  it('proposes a single clear candidate', () => {
    const result = proposeMatch(listing({ barcode: '111' }), [target({ barcode: '111' })]);

    expect(result.status).toBe('matched');
    // Even a certain match is only ever a proposal.
    if (result.status === 'matched') expect(result.candidate.confidence).toBe('certain');
  });

  /**
   * The property this module exists for. Two products with the same name in
   * different sets is not unusual — reprints are the norm in this hobby — and
   * picking one would silently point stock at the wrong listing.
   */
  it('reports a tie as ambiguous rather than choosing', () => {
    const result = proposeMatch(listing(), [
      target({ id: 'a', setName: 'Surging Sparks' }),
      target({ id: 'b', setName: 'Prismatic Evolutions' }),
    ]);

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.target.id).sort()).toEqual(['a', 'b']);
    }
  });

  it('is not ambiguous when one candidate is genuinely stronger', () => {
    const result = proposeMatch(listing({ barcode: '111' }), [
      target({ id: 'weak', setName: 'Surging Sparks' }),
      target({ id: 'strong', name: 'Different Name', barcode: '111' }),
    ]);

    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.candidate.target.id).toBe('strong');
  });

  it('reports nothing found as unmatched, not as an error', () => {
    // Every real store has oddments the catalogue has never heard of.
    expect(proposeMatch(listing({ title: 'Store Gift Card' }), [target()]).status).toBe(
      'unmatched',
    );
  });

  it('is unmatched against an empty catalogue', () => {
    expect(proposeMatch(listing(), []).status).toBe('unmatched');
  });
});

describe('proposeMatches', () => {
  it('skips listings that are already linked', () => {
    const linked = listing({ externalListingId: 'gid://already' });
    const fresh = listing({ externalListingId: 'gid://fresh' });

    const result = proposeMatches([linked, fresh], [target()], new Set(['gid://already']));

    // Re-proposing a working link invites an operator to repoint a live listing.
    expect(result.skipped).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.listing.externalListingId).toBe('gid://fresh');
  });

  it('summarises what a reviewer is about to face', () => {
    const result = proposeMatches(
      [
        listing({ externalListingId: '1', barcode: '111' }),
        listing({ externalListingId: '2' }),
        listing({ externalListingId: '3', title: 'Gift Card' }),
      ],
      [
        target({ id: 'a', barcode: '111' }),
        target({ id: 'b', setName: 'Surging Sparks' }),
        target({ id: 'c', setName: 'Prismatic Evolutions' }),
      ],
    );

    // 1 matches on barcode; 2 ties between b and c; 3 matches nothing.
    expect(result.summary).toEqual({ matched: 1, ambiguous: 1, unmatched: 1, certain: 1 });
  });

  it('counts only certain matches as safe to bulk-accept', () => {
    const summary = summarize([
      proposeMatch(listing({ externalListingId: '1', barcode: '1' }), [target({ barcode: '1' })]),
      proposeMatch(listing({ externalListingId: '2' }), [target({ setName: 'Surging Sparks' })]),
    ]);

    // The second is `probable`, and a bulk accept must not sweep it up.
    expect(summary.matched).toBe(2);
    expect(summary.certain).toBe(1);
  });

  it('handles an empty page without inventing a summary', () => {
    expect(proposeMatches([], [target()])).toEqual({
      proposals: [],
      summary: { matched: 0, ambiguous: 0, unmatched: 0, certain: 0 },
      skipped: 0,
    });
  });
});
