import { parseCsv, parseMoneyToCents, type CsvTable } from '@hub/connector-tcgplayer';
import type { CatalogCandidate } from '@hub/connector-sdk';

/**
 * Parsing and mapping for tcgcsv's published CSV files.
 *
 * Pure functions over text — no HTTP, no clock, no cache — so every shape below
 * is pinned by a fixture rather than by a live download.
 *
 * The CSV codec is borrowed from `@hub/connector-tcgplayer`. That is a slightly
 * odd dependency direction for a catalog package, and it is deliberate: the
 * reader there already handles quoted commas, embedded newlines, CRLF and a
 * UTF-8 BOM, and re-implementing it would mean a second set of bugs in the code
 * that decides what a price is. If a third consumer appears it should move to
 * the SDK.
 */

export const TCGCSV_KEY = 'tcgcsv';

/** The id namespace tcgcsv's own `productId` belongs to. */
export const TCGPLAYER_ID_KEY = 'tcgplayer';

export interface TcgcsvCategory {
  categoryId: string;
  /** Short form — "Magic", "Pokemon". This is what `CatalogItem.game` holds. */
  name: string;
  /** Long form — "Magic: The Gathering". Shown to a human, never keyed on. */
  displayName: string;
}

export interface TcgcsvGroup {
  groupId: string;
  /** A set name — "Star Trek", "Commander: Star Trek". */
  name: string;
  categoryId: string;
}

/**
 * One row of `ProductsAndPrices.csv`: a product joined to the prices for **one
 * printing**. A product sold in both finishes appears twice.
 */
export interface TcgcsvProductRow {
  productId: string;
  name: string;
  imageUrl?: string;
  categoryId: string;
  groupId: string;
  /** "Normal", "Foil", or absent — see `normalizePrinting`. */
  subTypeName?: string;
  marketPriceCents?: number;
  lowPriceCents?: number;
  /** Open-ended per-category extras (`extRarity`, `extNumber`, `extHP`, …). */
  extended: Readonly<Record<string, string>>;
}

/**
 * tcgcsv's finish names, mapped to the `printing` vocabulary `Sku` uses.
 *
 * "NORMAL" is the sentinel the schema requires for "no special printing", so an
 * absent or unrecognised finish becomes that rather than null — a nullable
 * printing would make `Sku`'s natural key unenforceable (NULL != NULL).
 */
const PRINTING_BY_SUBTYPE: Readonly<Record<string, string>> = {
  normal: 'NORMAL',
  foil: 'FOIL',
  holofoil: 'HOLOFOIL',
  'reverse holofoil': 'REVERSE_HOLOFOIL',
  'foil holo': 'HOLOFOIL',
  '1st edition': 'FIRST_EDITION',
  '1st edition holofoil': 'FIRST_EDITION_HOLOFOIL',
  unlimited: 'UNLIMITED',
  'unlimited holofoil': 'UNLIMITED_HOLOFOIL',
};

/**
 * Map a tcgcsv `subTypeName` onto a printing token.
 *
 * Real data contains an **empty** `subTypeName` — a sealed booster pack had one
 * in the fixture — which is a distinct fact from an unrecognised one and not a
 * problem. Both land on "NORMAL", but an unrecognised value is reported so a new
 * finish shows up as a message rather than as silently mispriced stock.
 */
export function normalizePrinting(subTypeName: string | undefined): {
  printing: string;
  unrecognised?: string;
} {
  const raw = (subTypeName ?? '').trim();
  if (raw === '') return { printing: 'NORMAL' };

  const mapped = PRINTING_BY_SUBTYPE[raw.toLowerCase()];
  if (mapped) return { printing: mapped };

  // Deliberately still usable: the row's identity is its productId, and losing a
  // real product is worse than flagging an unfamiliar finish.
  return { printing: raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), unrecognised: raw };
}

/**
 * Rewrite a TCGPlayer product image URL to a larger size.
 *
 * tcgcsv publishes the `_200w` thumbnail — 200 pixels wide, which reads as low
 * quality once it becomes a product photo on a storefront. The CDN serves the
 * same image at `_in_1000x1000` (~1000px, roughly 12× the bytes and far
 * sharper). This swaps the size token and leaves everything else alone; a URL
 * that does not match the `_<width>w` shape is returned untouched, so an
 * unfamiliar URL is never mangled. Exported so a one-off backfill can upgrade
 * URLs already stored.
 */
export function upgradeTcgplayerImage(url: string): string {
  return url.replace(/_\d+w(\.(?:jpg|jpeg|png|webp))$/i, '_in_1000x1000$1');
}

export function parseCategories(csv: string): TcgcsvCategory[] {
  const table = parseCsv(csv);
  return table.rows
    .filter((row) => row.categoryId)
    .map((row) => ({
      categoryId: row.categoryId ?? '',
      name: row.name ?? '',
      displayName: row.displayName || row.name || '',
    }));
}

export function parseGroups(csv: string): TcgcsvGroup[] {
  const table = parseCsv(csv);
  return table.rows
    .filter((row) => row.groupId)
    .map((row) => ({
      groupId: row.groupId ?? '',
      name: row.name ?? '',
      categoryId: row.categoryId ?? '',
    }));
}

/**
 * Columns that are not per-category extras. Everything else beginning `ext` is
 * carried through untouched.
 *
 * Read by name and never by position, because the header genuinely differs
 * between categories — Magic emits `extRarity, extNumber, extSubType, extP, extT,
 * extOracleText, extFlavorText` before the price block, while Pokémon emits
 * `extCardText` before it and `extNumber, extRarity, extCardType, extHP, …`
 * after. A fixed header set, which is what the TCGPlayer connector's `formats.ts`
 * uses for the operator's own exports, would break on every category but the one
 * it was written against.
 */
const CORE_COLUMNS = new Set([
  'productId',
  'name',
  'cleanName',
  'imageUrl',
  'categoryId',
  'groupId',
  'url',
  'modifiedOn',
  'imageCount',
  'lowPrice',
  'midPrice',
  'highPrice',
  'marketPrice',
  'directLowPrice',
  'subTypeName',
]);

export function parseProductsAndPrices(csv: string): TcgcsvProductRow[] {
  const table: CsvTable = parseCsv(csv);

  return table.rows
    .filter((row) => row.productId)
    .map((row) => {
      const extended: Record<string, string> = {};
      for (const header of table.headers) {
        if (CORE_COLUMNS.has(header)) continue;
        const value = row[header];
        if (value) extended[header] = value;
      }

      const parsed: TcgcsvProductRow = {
        productId: row.productId ?? '',
        name: row.name ?? '',
        categoryId: row.categoryId ?? '',
        groupId: row.groupId ?? '',
        extended,
      };

      if (row.imageUrl) parsed.imageUrl = upgradeTcgplayerImage(row.imageUrl);
      if (row.subTypeName) parsed.subTypeName = row.subTypeName;

      // Prices are read from their decimal text straight to integer cents. The
      // JSON form of this endpoint hands back real JSON numbers, and
      // `2.99 * 100` is `298.99999999999997` — which is why the CSV is the form
      // this package consumes.
      const market = parseMoneyToCents(row.marketPrice);
      if (market !== undefined) parsed.marketPriceCents = market;

      const low = parseMoneyToCents(row.lowPrice);
      if (low !== undefined) parsed.lowPriceCents = low;

      return parsed;
    });
}

/**
 * Collapse the per-printing rows of one product into a single candidate.
 *
 * `CatalogCandidate.marketPrice` is a scalar, so a product sold in two finishes
 * at two prices cannot be represented faithfully here. The non-foil price wins,
 * matching what the Scryfall source already does, and falls back to any printing
 * that has one — a foil-only product would otherwise report no price at all.
 * The per-printing prices are genuinely lost at this boundary; anything that
 * needs them has to read the rows.
 */
export function toCandidates(
  rows: readonly TcgcsvProductRow[],
  lookup: {
    categoryName?: (categoryId: string) => string | undefined;
    groupName?: (groupId: string) => string | undefined;
  } = {},
): CatalogCandidate[] {
  const byProduct = new Map<string, TcgcsvProductRow[]>();
  for (const row of rows) {
    const existing = byProduct.get(row.productId);
    if (existing) existing.push(row);
    else byProduct.set(row.productId, [row]);
  }

  const candidates: CatalogCandidate[] = [];

  for (const [productId, group] of byProduct) {
    const first = group[0];
    if (!first) continue;

    const printings: string[] = [];
    for (const row of group) {
      const { printing } = normalizePrinting(row.subTypeName);
      if (!printings.includes(printing)) printings.push(printing);
    }

    const normalRow = group.find((row) => normalizePrinting(row.subTypeName).printing === 'NORMAL');
    const marketPrice =
      normalRow?.marketPriceCents ??
      group.find((r) => r.marketPriceCents !== undefined)?.marketPriceCents;

    // tcgcsv's own id *is* the TCGPlayer product id, so both keys carry it. The
    // `tcgplayer` key is the point of this source: it is the namespace
    // `CatalogExternalRef` is keyed on, and the same one Scryfall's
    // `tcgplayer_id` lands in — product-level in both cases, so the two are
    // directly comparable. It is **not** the SKU-level id a TCGPlayer listing
    // uses; those live on an allocation's `externalListingId` and are a
    // different id space entirely.
    const candidate: CatalogCandidate = {
      sourceId: productId,
      name: first.name,
      externalIds: { [TCGCSV_KEY]: productId, [TCGPLAYER_ID_KEY]: productId },
    };

    const game = lookup.categoryName?.(first.categoryId);
    if (game) candidate.game = game;

    const setName = lookup.groupName?.(first.groupId);
    if (setName) candidate.setName = setName;

    if (first.imageUrl) candidate.imageUrl = first.imageUrl;
    if (marketPrice !== undefined) candidate.marketPrice = marketPrice;
    if (printings.length > 0) candidate.printings = printings;

    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Case- and punctuation-insensitive containment, for matching a typed query
 * against a product or set name.
 *
 * Mirrors why `CatalogItem.searchName` exists: a caller typing "uss enterprise"
 * should find "U.S.S. Enterprise-D, Galaxy-Class".
 */
export function looseIncludes(haystack: string, needle: string): boolean {
  const n = normalizeName(needle);
  if (n === '') return true;
  if (normalizeName(haystack).includes(n)) return true;

  // Then again with the separators gone entirely, because an initialism loses
  // its dots when typed: "U.S.S. Enterprise-D" normalizes to "u s s enterprise
  // d", which does not contain "uss enterprise d". Squashing both sides makes
  // "ussenterprised" match. This is the same trick `findHeader` uses on column
  // names, for the same reason.
  return squashName(haystack).includes(squashName(needle));
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function squashName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Pick the items whose name matches a query, **preferring an exact match**.
 *
 * The fallback to containment matters and so does the preference. Magic really
 * ships "Star Trek", "Commander: Star Trek" and "Star Trek: Stardates" at once,
 * so containment alone turns an operator naming one set precisely into three set
 * downloads — and, once past the download limit, into a refusal to search at all.
 * Exact-first means a precise name behaves precisely, while a partial one still
 * casts the wider net the caller presumably wanted.
 */
export function matchByName<T>(
  items: readonly T[],
  query: string,
  names: (item: T) => readonly string[],
): T[] {
  const wanted = normalizeName(query);
  if (wanted === '') return [...items];

  const squashed = squashName(query);
  const exact = items.filter((item) =>
    names(item).some((n) => normalizeName(n) === wanted || squashName(n) === squashed),
  );
  if (exact.length > 0) return exact;

  return items.filter((item) => names(item).some((n) => looseIncludes(n, query)));
}
