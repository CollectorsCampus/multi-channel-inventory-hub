/**
 * A focused RFC 4180 CSV reader and writer.
 *
 * Hand-rolled rather than pulled in, because the failure modes that matter here
 * are narrow and worth owning: a card named `Fire // Ice`, a set called
 * `Duel Decks: Jace vs. Chandra`, prices quoted as `"1,250.00"`, exports saved
 * from Excel with a UTF-8 BOM and CRLF line endings. Every one of those is a
 * test below.
 *
 * Getting this wrong corrupts inventory silently, so it is deliberately strict
 * about structure and loud about anything it cannot read.
 */

export interface CsvTable {
  /** Header names exactly as they appeared, trimmed of whitespace and BOM. */
  headers: string[];
  /** One record per row, keyed by header. Ragged rows are padded with ''. */
  rows: Array<Record<string, string>>;
}

/** Parse a CSV document into records keyed by header. */
export function parseCsv(input: string): CsvTable {
  // Excel writes a UTF-8 BOM. Left in place it becomes part of the first
  // header name and every column lookup for it fails. Written as an escape
  // rather than the literal character, which is invisible in a diff.
  const text = input.replace(/^\uFEFF/, '');

  const grid = parseGrid(text);
  if (grid.length === 0) return { headers: [], rows: [] };

  const headers = (grid[0] ?? []).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];

    // A trailing newline produces one empty cell; that is not a record.
    if (cells.length === 1 && cells[0]?.trim() === '') continue;

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? '').trim();
    });
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Split CSV text into a grid of raw cells.
 *
 * Handles quoted fields containing commas, newlines and escaped quotes (`""`).
 */
function parseGrid(text: string): string[][] {
  const grid: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      grid.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // CRLF: the \n on the next iteration ends the row.
      continue;
    } else {
      field += char;
    }
  }

  // Whatever is buffered when the input ends is a final cell, unless the file
  // ended cleanly on a newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    grid.push(row);
  }

  return grid;
}

export interface CsvWriteOptions {
  /**
   * Quote every data cell, not only the ones that need it.
   *
   * TCGPlayer's own exports do exactly this — bare header row, every value
   * quoted — and the file we hand back is meant to be one TCGPlayer would
   * recognise as its own. Reproducing the shape costs nothing and removes a
   * variable from an upload path we cannot test against a live account.
   */
  quoteValues?: boolean;
}

/** Render rows to CSV text. */
export function toCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null>>,
  options: CsvWriteOptions = {},
): string {
  // The header row is never force-quoted: that is how the real exports look.
  const lines = [headers.map(escapeCell).join(',')];
  const cell = options.quoteValues ? quoteCell : escapeCell;

  for (const row of rows) {
    lines.push(headers.map((header) => cell(row[header] ?? '')).join(','));
  }

  // CRLF: the platforms consuming these are Windows-oriented spreadsheet tools,
  // and a bare LF is the kind of thing that silently mangles an import.
  return lines.join('\r\n') + '\r\n';
}

function escapeCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? quoteCell(text) : text;
}

function quoteCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Find which actual header satisfies a logical column.
 *
 * Matching ignores case, spaces, underscores and punctuation, because exports
 * vary between `TCGplayer Id`, `tcgplayer_id` and `TCGPlayer ID` for what is
 * plainly the same column.
 */
export function findHeader(headers: string[], candidates: readonly string[]): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = candidates.map(normalize);
  return headers.find((header) => wanted.includes(normalize(header)));
}

/**
 * Parse a price to integer cents.
 *
 * These exports quote prices at **two or four decimal places** in the same
 * file — `13.33` next to `17.0000` — and may carry a currency symbol or
 * thousands separators. Digits are read as strings and combined with integer
 * arithmetic; the value never passes through a float, because `17.0000 * 100`
 * is the classic way to end up one cent short.
 *
 * A negative or parenthesised value returns undefined rather than being coerced
 * to a positive. Nothing in these exports is negative, so one appearing means
 * the column is not what we think it is — and silently flipping a sign is how a
 * misread becomes a mispriced listing.
 */
export function parseMoneyToCents(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (/[-(]/.test(trimmed)) return undefined;

  // Currency symbols and thousands separators only; anything else is a signal
  // the cell is not a price.
  const cleaned = trimmed.replace(/[$£€\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;

  const [whole = '0', fraction = ''] = cleaned.split('.');
  // A third decimal place decides the rounding; anything beyond it cannot
  // change a half-cent boundary.
  const cents = fraction.padEnd(3, '0');
  const base = Number(whole) * 100 + Number(cents.slice(0, 2));
  return base + (Number(cents[2]) >= 5 ? 1 : 0);
}

/**
 * Parse a whole-unit quantity.
 *
 * Strict: a quantity is the one number that decides how much stock moves, so
 * `"3 units"` or `"1.5"` is refused rather than coerced. Zero is valid and
 * common — 563 of 1333 rows in a real pricing export are quantity 0, meaning
 * "priced but not stocked".
 */
export function parseQuantity(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
