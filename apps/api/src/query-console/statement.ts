/**
 * Statement shape checks for the query console.
 *
 * **These are not the security boundary.** Two things actually stop the console
 * writing: the separate database role the operator grants it, and the
 * `READ ONLY` transaction every statement runs inside — both enforced by
 * PostgreSQL, neither defeatable by clever SQL. This file is the third layer,
 * and its job is to turn an obvious mistake into a clear message instead of a
 * driver error.
 *
 * Treating a regex over SQL as a real defence is how injection filters get
 * written. It is stated here so nobody later removes the transaction on the
 * grounds that "we validate the SQL anyway".
 */

export type StatementCheck = { ok: true } | { ok: false; reason: string };

/** Statement kinds worth allowing through a read-only console. */
const ALLOWED_LEADING = ['select', 'with', 'explain', 'show', 'table', 'values'];

/**
 * Reject what is obviously not a read.
 *
 * Deliberately permissive about what it allows and strict about multiple
 * statements: a trailing `; DROP ...` is the one shape where a bad message
 * would be actively misleading, since the read-only transaction would refuse it
 * with an error about the wrong half of the input.
 */
export function checkStatement(sql: string): StatementCheck {
  const trimmed = sql.trim();

  if (trimmed === '') {
    return { ok: false, reason: 'Enter a statement to run.' };
  }

  if (countStatements(trimmed) > 1) {
    return {
      ok: false,
      reason: 'Run one statement at a time. Separate statements with a semicolon are refused.',
    };
  }

  const leading = leadingKeyword(trimmed);
  if (!leading) {
    return { ok: false, reason: 'Could not read a leading keyword from this statement.' };
  }

  if (!ALLOWED_LEADING.includes(leading)) {
    return {
      ok: false,
      reason:
        `This console is read-only, so it will not run \`${leading.toUpperCase()}\`. ` +
        `Changes to inventory go through the API's validated endpoints, which is what keeps ` +
        `the allocation invariant enforceable.`,
    };
  }

  return { ok: true };
}

/**
 * The first bare word, ignoring leading comments.
 *
 * Both line comments and block comments are skipped: a statement pasted out of
 * a saved query usually arrives with a header explaining it, and refusing that
 * for looking like nothing at all would be an annoying way to be wrong.
 */
export function leadingKeyword(sql: string): string | undefined {
  let rest = sql.trimStart();

  // Strip any run of leading comments.
  for (;;) {
    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      if (newline === -1) return undefined;
      rest = rest.slice(newline + 1).trimStart();
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      if (close === -1) return undefined;
      rest = rest.slice(close + 2).trimStart();
      continue;
    }
    break;
  }

  return /^([a-z]+)/i.exec(rest)?.[1]?.toLowerCase();
}

/**
 * How many statements the input contains.
 *
 * Semicolons inside string literals, quoted identifiers, dollar-quoted bodies
 * and comments do not separate anything — a WHERE clause matching `'a;b'` is
 * ordinary, and counting it as two statements would refuse a legitimate query.
 * A single trailing semicolon is normal and does not count.
 */
export function countStatements(sql: string): number {
  let statements = 0;
  let hasContent = false;

  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (char === '-' && next === '-') {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }

    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }

    if (char === "'" || char === '"') {
      i = skipQuoted(sql, i, char);
      hasContent = true;
      continue;
    }

    // Dollar quoting: $tag$ ... $tag$, which is how function bodies are written
    // and the one place a semicolon is most likely to appear harmlessly.
    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        hasContent = true;
        continue;
      }
    }

    if (char === ';') {
      if (hasContent) statements++;
      hasContent = false;
      i++;
      continue;
    }

    if (!/\s/.test(char)) hasContent = true;
    i++;
  }

  // Trailing content with no closing semicolon is still a statement.
  return hasContent ? statements + 1 : statements;
}

/** Advance past a quoted run, honouring the doubled-quote escape. */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}
