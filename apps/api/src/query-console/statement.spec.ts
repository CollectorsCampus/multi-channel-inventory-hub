import { describe, expect, it } from 'vitest';
import { checkStatement, countStatements, leadingKeyword } from './statement';

/**
 * The statement checks, which are the console's *third* line of defence and
 * must never be mistaken for its first.
 *
 * These tests are about message quality and about not refusing legitimate
 * queries. The tests that prove the console cannot write live in
 * query-console.service.spec.ts and run against a real PostgreSQL, because that
 * is the only place the claim can actually be demonstrated.
 */

describe('checkStatement', () => {
  it.each([
    'SELECT 1',
    'select * from inventory_items',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN SELECT 1',
    'SHOW timezone',
    'TABLE inventory_items',
    'VALUES (1), (2)',
    '  \n SELECT 1  ',
    '-- how many do we hold?\nSELECT count(*) FROM inventory_items',
    '/* saved query */ SELECT 1',
  ])('allows %j', (sql) => {
    expect(checkStatement(sql)).toEqual({ ok: true });
  });

  it.each([
    ['INSERT INTO skus (id) VALUES (1)', 'INSERT'],
    ['UPDATE inventory_items SET quantity_on_hand = 0', 'UPDATE'],
    ['DELETE FROM alerts', 'DELETE'],
    ['DROP TABLE sessions', 'DROP'],
    ['TRUNCATE inventory_items', 'TRUNCATE'],
    ['ALTER TABLE skus ADD COLUMN x int', 'ALTER'],
    ['GRANT ALL ON skus TO hub', 'GRANT'],
    ["COPY skus FROM '/etc/passwd'", 'COPY'],
  ])('refuses %j, naming the keyword', (sql, keyword) => {
    const result = checkStatement(sql);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(keyword);
  });

  it('explains why rather than just saying no', () => {
    const result = checkStatement('UPDATE inventory_items SET quantity_on_hand = 0');
    // An operator refused by a tool deserves to know where the door is.
    expect(result.ok === false && result.reason).toMatch(/allocation invariant/);
  });

  it('asks for a statement when given nothing', () => {
    expect(checkStatement('   ')).toEqual({
      ok: false,
      reason: expect.stringContaining('Enter a statement'),
    });
  });

  /**
   * The read-only transaction would refuse the write half anyway, but its error
   * would name the second statement and read like the console is broken. This
   * is the one shape where a clear message is worth the parsing.
   */
  it('refuses a second statement smuggled behind a semicolon', () => {
    const result = checkStatement('SELECT 1; DROP TABLE sessions');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/one statement at a time/i);
  });

  it('allows a single trailing semicolon, which is how people type', () => {
    expect(checkStatement('SELECT 1;')).toEqual({ ok: true });
  });
});

describe('countStatements', () => {
  it('counts a bare statement as one', () => {
    expect(countStatements('SELECT 1')).toBe(1);
    expect(countStatements('SELECT 1;')).toBe(1);
    expect(countStatements('SELECT 1;  ')).toBe(1);
  });

  it('counts two', () => {
    expect(countStatements('SELECT 1; SELECT 2')).toBe(2);
    expect(countStatements('SELECT 1; SELECT 2;')).toBe(2);
  });

  it('counts nothing in an empty or comment-only input', () => {
    expect(countStatements('')).toBe(0);
    expect(countStatements('   ')).toBe(0);
    expect(countStatements('-- just a note')).toBe(0);
  });

  /**
   * Everything below is a legitimate query that a naive `split(';')` would
   * refuse. Being wrong in this direction is not a security failure but it is
   * an infuriating tool.
   */
  it('ignores a semicolon inside a string literal', () => {
    expect(countStatements("SELECT * FROM skus WHERE printing = 'a;b'")).toBe(1);
  });

  it('ignores a semicolon inside a quoted identifier', () => {
    expect(countStatements('SELECT "odd;name" FROM skus')).toBe(1);
  });

  it('ignores a semicolon inside a line comment', () => {
    expect(countStatements('SELECT 1 -- ; not a statement\n')).toBe(1);
  });

  it('ignores a semicolon inside a block comment', () => {
    expect(countStatements('SELECT 1 /* ; still not */')).toBe(1);
  });

  it('ignores a semicolon inside a dollar-quoted body', () => {
    expect(countStatements('SELECT $$a;b$$')).toBe(1);
    expect(countStatements('SELECT $tag$a;b$tag$')).toBe(1);
  });

  it('handles a doubled quote escape without losing track', () => {
    expect(countStatements("SELECT 'it''s fine; really'")).toBe(1);
  });

  it('does not run off the end of an unterminated literal', () => {
    // Malformed SQL is the database's problem to report, not ours to hang on.
    expect(countStatements("SELECT 'unterminated")).toBe(1);
    expect(countStatements('SELECT /* unterminated')).toBe(1);
  });
});

describe('leadingKeyword', () => {
  it('reads the first word', () => {
    expect(leadingKeyword('SELECT 1')).toBe('select');
    expect(leadingKeyword('  \n\t select 1')).toBe('select');
  });

  it('looks past a stack of comments', () => {
    expect(leadingKeyword('-- one\n-- two\n/* three */ SELECT 1')).toBe('select');
  });

  it('gives up on an unterminated comment rather than guessing', () => {
    expect(leadingKeyword('/* never closed')).toBeUndefined();
    expect(leadingKeyword('-- never ends')).toBeUndefined();
  });
});
