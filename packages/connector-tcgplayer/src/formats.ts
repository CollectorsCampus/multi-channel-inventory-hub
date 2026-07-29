/**
 * The two TCGPlayer exports this connector reads, by their real headers.
 *
 * Verified against a live TCGPlayer Pro account on 2026-07-28. Redacted
 * fixtures preserving every shape below live in `test/fixtures/`.
 *
 * ## Why the headers are fixed rather than configurable
 *
 * An earlier draft of this connector resolved every column through an
 * operator-editable alias list. That was a hedge against not knowing the real
 * headers, and it bought exactly one thing: a channel setting nobody could fill
 * in correctly, which would have let an operator point our quantity column at
 * TCGPlayer's *market price* column and silently rewrite their stock.
 *
 * The headers are known now, so they are a constant. The short alias lists here
 * exist only for spellings the same column plausibly appears under — and header
 * matching already ignores case, spaces and punctuation, so `TCGplayer Id`,
 * `TCGPLAYER ID` and `tcgplayer_id` need no alias at all.
 *
 * ## The three-way rule
 *
 * - **required** — columns this connector actually reads. One missing rejects
 *   the whole file, naming what it wanted and what it saw. This is what makes
 *   uploading a pull sheet to the inventory endpoint fail loudly instead of
 *   importing zeroes.
 * - **known** — the rest of the documented export. Present in a healthy file,
 *   unread by us.
 * - anything else — reported once, as a single informational problem. Not fatal:
 *   TCGPlayer adding a column should not stop an operator syncing, but they
 *   should hear that their export no longer looks like the one we verified.
 */

import { findHeader, type CsvTable } from './csv';

export interface FileFormat {
  /** Name an operator would recognise from the TCGPlayer UI. */
  readonly label: string;
  /** Columns we read. A missing one rejects the file. */
  readonly required: Readonly<Record<string, readonly string[]>>;
  /** Documented columns we do not read, so they are not reported as strangers. */
  readonly known: readonly string[];
}

/**
 * `MyPricing` — the inventory export, and the shape `listing.export` emits.
 *
 * Header row unquoted, every value quoted, CRLF line endings.
 */
export const MY_PRICING = {
  label: 'MyPricing',
  required: {
    // SKU-level, not product-level: the same card in Near Mint Foil and Lightly
    // Played Foil has two different ids, which is why this alone is enough to
    // identify a listing.
    tcgplayerId: ['TCGplayer Id'],
    condition: ['Condition'],
    totalQuantity: ['Total Quantity'],
    marketplacePrice: ['TCG Marketplace Price'],
  },
  known: [
    'Product Line',
    'Set Name',
    'Product Name',
    'Title',
    'Number',
    'Rarity',
    'TCG Market Price',
    'TCG Direct Low',
    'TCG Low Price With Shipping',
    'TCG Low Price',
    'Add to Quantity',
    'Photo URL',
    // Present only on some accounts, per TCGPlayer's own column glossary: the
    // My Store pair appears when that channel is enabled, and Pending Quantity
    // covers stock committed to an order but not yet shipped. Listing them here
    // stops a perfectly healthy export from reporting unrecognised columns.
    'My Store Reserve Quantity',
    'My Store Price',
    'Pending Quantity',
  ],
} as const satisfies FileFormat;

/**
 * `PullSheet` — the only export carrying line-item sales.
 *
 * Header row unquoted, every value quoted, **LF** line endings: the two exports
 * disagree, which is why the parser handles both.
 *
 * `OrderList` is deliberately absent — it carries order totals with no products,
 * so it cannot decrement anything. `ShippingExport` and `PackingSlips` are
 * absent for a stronger reason: they contain customers' full names and postal
 * addresses, and this application has no business holding either.
 */
export const PULL_SHEET = {
  label: 'PullSheet',
  required: {
    // Same id space as MyPricing's `TCGplayer Id` — 218 of 219 pull-sheet ids
    // appeared in the pricing export — so both map to the same allocation.
    skuId: ['SkuId'],
    condition: ['Condition'],
    quantity: ['Quantity'],
    // Not a quantity. `<order#>:<qty>`, pipe-separated across orders.
    orderQuantity: ['Order Quantity'],
  },
  known: [
    'Product Line',
    'Product Name',
    'Number',
    'Set',
    'Rarity',
    'Main Photo URL',
    'Set Release Date',
  ],
} as const satisfies FileFormat;

/** The full column list of an export, for error messages. */
export function allColumns(format: FileFormat): string[] {
  return [...Object.values(format.required).map((names) => names[0]!), ...format.known];
}

export type ResolvedColumns<F extends FileFormat> = Record<keyof F['required'], string>;

export type FormatMatch<F extends FileFormat> =
  | { ok: true; columns: ResolvedColumns<F>; unexpected: string[] }
  | { ok: false; missing: string[] };

/**
 * Check a parsed table against a format, resolving each required column to the
 * header that actually satisfied it.
 *
 * Returning the resolved names rather than reading by literal header is what
 * lets alias and casing tolerance exist in one place instead of at every call
 * site.
 */
export function matchFormat<F extends FileFormat>(table: CsvTable, format: F): FormatMatch<F> {
  const columns: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, candidates] of Object.entries(format.required)) {
    const header = findHeader(table.headers, candidates);
    if (header === undefined) missing.push(candidates[0]!);
    else columns[key] = header;
  }

  if (missing.length > 0) return { ok: false, missing };

  const accounted = new Set(
    [...Object.values(format.required).flat(), ...format.known].map(normalizeHeader),
  );
  const unexpected = table.headers.filter(
    (header) => header !== '' && !accounted.has(normalizeHeader(header)),
  );

  return { ok: true, columns: columns as ResolvedColumns<F>, unexpected };
}

/**
 * Explain a rejection in terms an operator can act on.
 *
 * Naming the file we expected matters more than naming the missing column: the
 * commonest way to get here is uploading the right file to the wrong place, and
 * "this looks like a PullSheet" is the sentence that fixes it.
 */
export function describeMismatch(format: FileFormat, missing: string[], headers: string[]): string {
  const saw = headers.length > 0 ? headers.join(', ') : '(no header row)';
  return (
    `This does not look like a TCGPlayer ${format.label} export. ` +
    `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
    `Columns present: ${saw}.`
  );
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
