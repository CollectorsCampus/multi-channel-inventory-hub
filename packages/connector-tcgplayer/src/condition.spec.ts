import { describe, expect, it } from 'vitest';
import {
  TCG_CONDITIONS,
  TCG_EDITIONS,
  TCG_FINISHES,
  formatCondition,
  fromPrinting,
  parseCondition,
  toPrinting,
} from './condition';

/**
 * The condition parser is the one place in this connector where being clever is
 * dangerous.
 *
 * Every other mistake here produces a number that is visibly wrong. A condition
 * misread produces a listing that looks entirely correct and describes the wrong
 * physical card — a Japanese Charizard sold as an English one, at the English
 * price. So these tests care as much about what the parser *refuses* to do as
 * about what it parses.
 */

describe('parseCondition', () => {
  /** Every distinct shape found in a real Pro account's exports. */
  const REAL = [
    ['Unopened', { condition: 'SEALED', edition: null, finish: 'NORMAL', language: 'EN' }],
    ['Near Mint Holofoil', { condition: 'NM', edition: null, finish: 'HOLOFOIL', language: 'EN' }],
    [
      'Lightly Played Holofoil',
      { condition: 'LP', edition: null, finish: 'HOLOFOIL', language: 'EN' },
    ],
    ['Near Mint Foil', { condition: 'NM', edition: null, finish: 'FOIL', language: 'EN' }],
    [
      'Near Mint Reverse Holofoil',
      { condition: 'NM', edition: null, finish: 'REVERSE_HOLOFOIL', language: 'EN' },
    ],
    [
      'Lightly Played 1st Edition',
      { condition: 'LP', edition: '1ST_EDITION', finish: 'NORMAL', language: 'EN' },
    ],
    [
      'Near Mint Holofoil - Japanese',
      { condition: 'NM', edition: null, finish: 'HOLOFOIL', language: 'JA' },
    ],
    [
      'Moderately Played Unlimited Holofoil',
      { condition: 'MP', edition: 'UNLIMITED', finish: 'HOLOFOIL', language: 'EN' },
    ],
  ] as const;

  it.each(REAL)('splits %s', (raw, expected) => {
    const parsed = parseCondition(raw);
    expect(parsed.status).toBe('parsed');
    expect(parsed.status === 'parsed' && parsed.value).toEqual(expected);
  });

  /**
   * Real exports contain blank conditions. That is data, not corruption, so it
   * gets its own outcome — reporting it as a problem would bury the genuine
   * failures under noise from rows that are working exactly as intended.
   */
  it('treats an empty condition as absent, not as an error', () => {
    expect(parseCondition('').status).toBe('absent');
    expect(parseCondition('   ').status).toBe('absent');
  });

  it('reads Reverse Holofoil as itself rather than as Holofoil', () => {
    const parsed = parseCondition('Near Mint Reverse Holofoil');
    expect(parsed.status === 'parsed' && parsed.value.finish).toBe('REVERSE_HOLOFOIL');
  });

  describe('refuses to guess', () => {
    /**
     * The whole point. Every one of these could be "helpfully" defaulted to
     * English Near Mint, and every such default is a mispriced listing.
     */
    it('rejects an unknown language rather than defaulting to English', () => {
      const parsed = parseCondition('Near Mint Holofoil - Klingon');
      expect(parsed.status).toBe('unrecognised');
      expect(parsed.status === 'unrecognised' && parsed.detail).toMatch(/Klingon/);
    });

    it('rejects an unknown condition rather than defaulting to Near Mint', () => {
      expect(parseCondition('Pristine Holofoil').status).toBe('unrecognised');
    });

    it('rejects an unknown finish rather than dropping it', () => {
      // Scryfall reports etched finishes for Magic. If TCGPlayer spells one
      // some way we have not verified, silently filing it as a normal foil
      // would merge two different cards.
      const parsed = parseCondition('Near Mint Etched Foil');
      expect(parsed.status).toBe('unrecognised');
      expect(parsed.status === 'unrecognised' && parsed.detail).toMatch(/Etched/i);
    });

    it('rejects trailing text it cannot account for', () => {
      expect(parseCondition('Near Mint Holofoil Signed').status).toBe('unrecognised');
    });

    it('reports the original string, so an operator can search for it', () => {
      const parsed = parseCondition('Wildly Unexpected');
      expect(parsed.status === 'unrecognised' && parsed.raw).toBe('Wildly Unexpected');
    });
  });

  /**
   * Card names really do contain hyphens (Ho-Oh, Porygon-Z). The language split
   * looks for ` - ` with spaces so a name cannot be amputated by it.
   */
  it('does not treat a hyphen inside a word as a language separator', () => {
    expect(parseCondition('Near Mint Holo-foil').status).toBe('unrecognised');
  });
});

describe('printing tokens', () => {
  it('round-trips every edition and finish combination', () => {
    for (const finish of TCG_FINISHES) {
      for (const edition of [null, ...TCG_EDITIONS]) {
        const token = toPrinting(edition, finish);
        expect(fromPrinting(token), token).toEqual({ edition, finish });
      }
    }
  });

  it('names a plain first edition without a redundant finish', () => {
    expect(toPrinting('1ST_EDITION', 'NORMAL')).toBe('1ST_EDITION');
  });

  it('matches the uppercase-token convention the catalog source already writes', () => {
    expect(toPrinting(null, 'NORMAL')).toBe('NORMAL');
    expect(toPrinting(null, 'FOIL')).toBe('FOIL');
  });

  it('refuses a printing that is not ours', () => {
    // ETCHED and GLOSSY come from Scryfall and have no verified TCGPlayer
    // spelling. Better to fail the export than to invent one.
    expect(fromPrinting('ETCHED')).toBeUndefined();
    expect(fromPrinting('1ST_EDITION_ETCHED')).toBeUndefined();
  });
});

describe('formatCondition', () => {
  it('rebuilds every real export value exactly', () => {
    // The recombined string has to match TCGPlayer's own spelling character for
    // character. A near-miss matches nothing on their side and the upload is a
    // silent no-op.
    const cases: Array<[{ condition: string; printing: string; language: string }, string]> = [
      [{ condition: 'SEALED', printing: 'NORMAL', language: 'EN' }, 'Unopened'],
      [{ condition: 'NM', printing: 'HOLOFOIL', language: 'EN' }, 'Near Mint Holofoil'],
      [{ condition: 'LP', printing: 'HOLOFOIL', language: 'EN' }, 'Lightly Played Holofoil'],
      [{ condition: 'NM', printing: 'FOIL', language: 'EN' }, 'Near Mint Foil'],
      [
        { condition: 'NM', printing: 'REVERSE_HOLOFOIL', language: 'EN' },
        'Near Mint Reverse Holofoil',
      ],
      [{ condition: 'LP', printing: '1ST_EDITION', language: 'EN' }, 'Lightly Played 1st Edition'],
      [{ condition: 'NM', printing: 'HOLOFOIL', language: 'JA' }, 'Near Mint Holofoil - Japanese'],
      [
        { condition: 'MP', printing: 'UNLIMITED_HOLOFOIL', language: 'EN' },
        'Moderately Played Unlimited Holofoil',
      ],
    ];

    for (const [sku, expected] of cases) {
      expect(formatCondition(sku), JSON.stringify(sku)).toEqual({ ok: true, value: expected });
    }
  });

  it('is the exact inverse of parseCondition across the whole vocabulary', () => {
    for (const condition of TCG_CONDITIONS) {
      for (const finish of TCG_FINISHES) {
        for (const edition of [null, ...TCG_EDITIONS]) {
          for (const language of ['EN', 'JA', 'ZHS']) {
            const formatted = formatCondition({
              condition,
              printing: toPrinting(edition, finish),
              language,
            });
            expect(formatted.ok, `${condition}/${edition}/${finish}/${language}`).toBe(true);
            if (!formatted.ok) continue;

            const parsed = parseCondition(formatted.value);
            expect(parsed.status, formatted.value).toBe('parsed');
            expect(parsed.status === 'parsed' && parsed.value).toEqual({
              condition,
              edition,
              finish,
              language,
            });
          }
        }
      }
    }
  });

  it('omits the language suffix for English, as TCGPlayer does', () => {
    expect(formatCondition({ condition: 'NM', printing: 'NORMAL', language: 'EN' })).toEqual({
      ok: true,
      value: 'Near Mint',
    });
  });

  describe('fails rather than approximating', () => {
    it('refuses a condition TCGPlayer has no spelling for', () => {
      // `NA` exists in the core's vocabulary as "not applicable".
      const result = formatCondition({ condition: 'NA', printing: 'NORMAL', language: 'EN' });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('NA') });
    });

    it('refuses a printing TCGPlayer has no spelling for', () => {
      const result = formatCondition({ condition: 'NM', printing: 'ETCHED', language: 'EN' });
      expect(result.ok).toBe(false);
    });

    it('refuses a language TCGPlayer has no spelling for', () => {
      const result = formatCondition({ condition: 'NM', printing: 'NORMAL', language: 'XX' });
      expect(result.ok).toBe(false);
    });
  });
});
