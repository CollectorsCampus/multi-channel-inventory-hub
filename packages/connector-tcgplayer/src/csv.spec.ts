import { describe, expect, it } from 'vitest';
import { parseCsv, parseMoneyToCents, parseQuantity, toCsv } from './csv';

/**
 * The CSV codec, exercised against the shapes that actually appear in card
 * data rather than against a generic RFC 4180 checklist.
 *
 * A card named `Fire // Ice`, a set called `Duel Decks: Jace vs. Chandra`, a
 * price quoted `"1,250.00"`, an export saved from Excel with a BOM — every one
 * of these has silently corrupted somebody's inventory in some other tool.
 */

describe('parseCsv', () => {
  it('reads quoted fields containing commas', () => {
    const table = parseCsv('a,b\n"Example Creature, the Wanderer","x"\n');
    expect(table.rows[0]).toEqual({ a: 'Example Creature, the Wanderer', b: 'x' });
  });

  it('reads doubled quotes as one literal quote', () => {
    const table = parseCsv('a\n"Example ""Quoted"" Card"\n');
    expect(table.rows[0]!.a).toBe('Example "Quoted" Card');
  });

  it('reads newlines inside a quoted field', () => {
    const table = parseCsv('a,b\n"line one\nline two",x\n');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.a).toBe('line one\nline two');
  });

  /**
   * The two TCGPlayer exports disagree: MyPricing is CRLF, PullSheet is LF.
   * A parser that handles one and not the other silently reads half the data.
   */
  it.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
  ])('handles %s line endings', (_name, eol) => {
    const table = parseCsv(`a,b${eol}"1","2"${eol}"3","4"${eol}`);
    expect(table.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('strips a UTF-8 BOM, which would otherwise poison the first header name', () => {
    const table = parseCsv('\uFEFFTCGplayer Id,Condition\n"1","Near Mint"\n');
    expect(table.headers[0]).toBe('TCGplayer Id');
    expect(table.rows[0]!['TCGplayer Id']).toBe('1');
  });

  it('does not produce a phantom row from a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toHaveLength(1);
  });

  it('returns nothing for an empty document rather than throwing', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('pads a short row instead of shifting columns into the wrong keys', () => {
    const table = parseCsv('a,b,c\n1,2\n');
    expect(table.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });
});

describe('toCsv', () => {
  it('quotes every value when asked, leaving the header row bare', () => {
    // TCGPlayer's own exports look exactly like this, and the file we hand back
    // is meant to be one they would recognise as their own.
    const csv = toCsv(['a', 'b'], [{ a: '1', b: 'x' }], { quoteValues: true });
    expect(csv).toBe('a,b\r\n"1","x"\r\n');
  });

  it('quotes only what needs it by default', () => {
    expect(toCsv(['a', 'b'], [{ a: 'plain', b: 'has,comma' }])).toBe(
      'a,b\r\nplain,"has,comma"\r\n',
    );
  });

  it('escapes embedded quotes so the file survives a round trip', () => {
    const csv = toCsv(['a'], [{ a: 'Example "Quoted" Card' }], { quoteValues: true });
    expect(parseCsv(csv).rows[0]!.a).toBe('Example "Quoted" Card');
  });

  it('renders a missing value as empty rather than as "undefined"', () => {
    expect(toCsv(['a', 'b'], [{ a: '1' }])).toBe('a,b\r\n1,\r\n');
  });
});

describe('parseMoneyToCents', () => {
  /**
   * The same export quotes prices at two *and* four decimal places. Both have
   * to land on the same cent, and neither may go through a float — `17.0000 *
   * 100` is the classic way to end up one cent short.
   */
  it.each([
    ['13.33', 1333],
    ['17.0000', 1700],
    ['0.0500', 5],
    ['1249.9900', 124999],
    ['1,250.00', 125000],
    ['$4.21', 421],
    ['7', 700],
  ])('reads %s as %i cents', (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it('rounds a half cent up rather than truncating', () => {
    expect(parseMoneyToCents('0.055')).toBe(6);
    expect(parseMoneyToCents('0.054')).toBe(5);
  });

  it('returns undefined for an empty or unreadable value', () => {
    expect(parseMoneyToCents('')).toBeUndefined();
    expect(parseMoneyToCents(undefined)).toBeUndefined();
    expect(parseMoneyToCents('n/a')).toBeUndefined();
  });

  /**
   * Nothing in these exports is negative. One appearing means the column is not
   * what we think it is, and quietly flipping the sign would turn a misread
   * into a mispriced listing.
   */
  it('refuses a negative or parenthesised value instead of coercing it positive', () => {
    expect(parseMoneyToCents('-1.00')).toBeUndefined();
    expect(parseMoneyToCents('(1.00)')).toBeUndefined();
  });
});

describe('parseQuantity', () => {
  it('reads a plain integer, including zero', () => {
    expect(parseQuantity('0')).toBe(0);
    expect(parseQuantity('12')).toBe(12);
    expect(parseQuantity(' 3 ')).toBe(3);
  });

  it('refuses anything that is not exactly an integer', () => {
    // A quantity decides how much stock moves. Coercing "3 units" or "1.5" into
    // a number is how a typo becomes an oversell.
    expect(parseQuantity('1.5')).toBeUndefined();
    expect(parseQuantity('3 units')).toBeUndefined();
    expect(parseQuantity('')).toBeUndefined();
    expect(parseQuantity(undefined)).toBeUndefined();
  });
});
