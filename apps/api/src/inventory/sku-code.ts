/**
 * The hub's own identifier for one `Sku`, as a single string.
 *
 * Written into a channel's seller-SKU field by `listing.sku`, and read back by
 * the matcher. Pure functions, no I/O — the same rule `allocation.ts` and
 * `propose.ts` follow.
 *
 * ## Why a composite, when a bare product id already worked
 *
 * The 139 SKUs written to the live store on 2026-07-30 carry tcgcsv's
 * **product**-level id. That is the right granularity for sealed product, where
 * one product is one variant, and the **wrong** granularity for singles: a card
 * in Near Mint and the same card in Damaged share that id, so the matcher's
 * `certain` path — an equality test — would equate them. Pointing inventory at
 * the wrong condition is not a cosmetic error; condition is most of what a
 * single is worth.
 *
 * So the code carries `Sku`'s natural key, which already has exactly the right
 * shape: catalogue product, condition, printing, language.
 *
 *     tcgcsv:662182:NM:1ST_EDITION_HOLOFOIL:EN
 *
 * **Edition is not a separate segment, on purpose.** `printing` already packs
 * edition and finish into one composite token (`HOLOFOIL`,
 * `1ST_EDITION_HOLOFOIL`, `UNLIMITED_HOLOFOIL`) because TCGPlayer's `Condition`
 * column packs the same four dimensions into one string, and `connector-
 * tcgplayer`'s `condition.ts` splits and rebuilds it losslessly. Giving edition
 * its own segment here would mean changing `Sku`'s natural key — a migration
 * touching intake, matching and that round trip — to express something already
 * expressible.
 *
 * ## Why colons
 *
 * The operator's existing seller SKUs are dash-heavy (`10-10050-122`,
 * `UGDSQR######`, `ULP#####`), so a dash separator could not be told apart from
 * a code someone else wrote. A colon appears in none of them.
 *
 * ## The parser must be strict, because it runs on other people's data
 *
 * `parseSkuCode` is called on **every** listing SKU in a store during a
 * proposal run — 434 of the operator's 867 listings carry a SKU that has
 * nothing to do with this hub. A loose parser that read one of those as a code
 * would report `certain` on a guess, which is the one outcome offered for bulk
 * acceptance. Anything that is not exactly five well-formed segments is
 * rejected, and rejection is the ordinary case rather than an error.
 *
 * Nothing here normalises. `encodeSkuCode` refuses a part it could not parse
 * back rather than tidying it, for the same reason `updateListingSku` writes
 * verbatim: a value that changes shape between writing and reading turns
 * tomorrow's exact match back into a guess.
 */

/** One `Sku`, identified through a catalogue source. */
export interface SkuCode {
  /** Catalog source key — the `source` on `CatalogExternalRef`. */
  sourceKey: string;
  /** That source's product id. */
  sourceId: string;
  /** `SkuCondition`: NM | LP | MP | HP | DMG | SEALED | NA. */
  condition: string;
  /** Composite edition+finish token; `NORMAL` when there is nothing to say. */
  printing: string;
  language: string;
}

export const SKU_CODE_SEPARATOR = ':';

/**
 * Shapes rather than vocabularies, deliberately.
 *
 * `printing` is open by construction — it is a composite of two vocabularies —
 * and a new language code should not need a change here. Validating the shape
 * is strict enough that no real-world seller SKU passes, without pinning a list
 * that will be wrong later.
 */
const SOURCE_KEY = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOKEN = /^[A-Z0-9][A-Z0-9_]*$/;

const SEGMENTS = 5;

/**
 * Render a code, or throw if it could not be read back.
 *
 * Throws rather than returning undefined because every caller is about to write
 * the result into somebody's live storefront. A malformed code there is worse
 * than a failed run: it is a listing stamped with an identifier nothing can
 * resolve, and it survives until someone notices by hand.
 */
export function encodeSkuCode(parts: SkuCode): string {
  const problems: string[] = [];

  if (!SOURCE_KEY.test(parts.sourceKey)) problems.push(`sourceKey "${parts.sourceKey}"`);
  if (!SOURCE_ID.test(parts.sourceId)) problems.push(`sourceId "${parts.sourceId}"`);
  if (!TOKEN.test(parts.condition)) problems.push(`condition "${parts.condition}"`);
  if (!TOKEN.test(parts.printing)) problems.push(`printing "${parts.printing}"`);
  if (!TOKEN.test(parts.language)) problems.push(`language "${parts.language}"`);

  if (problems.length > 0) {
    throw new Error(
      `Cannot build a SKU code from ${problems.join(', ')}. A code must round-trip, so a part ` +
        `that would not parse back is refused rather than written to a channel.`,
    );
  }

  return [parts.sourceKey, parts.sourceId, parts.condition, parts.printing, parts.language].join(
    SKU_CODE_SEPARATOR,
  );
}

/**
 * Read a code, or `undefined` when the value is not one.
 *
 * `undefined` is the expected answer for most seller SKUs in a real store, so
 * it is not an error condition and must never be logged as one.
 */
export function parseSkuCode(value: string | undefined | null): SkuCode | undefined {
  if (typeof value !== 'string') return undefined;

  // No trimming: a code with whitespace around it is not one we wrote, and
  // accepting it would mean writing and reading disagree about the value.
  const parts = value.split(SKU_CODE_SEPARATOR);
  if (parts.length !== SEGMENTS) return undefined;

  const [sourceKey, sourceId, condition, printing, language] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (!SOURCE_KEY.test(sourceKey)) return undefined;
  if (!SOURCE_ID.test(sourceId)) return undefined;
  if (!TOKEN.test(condition)) return undefined;
  if (!TOKEN.test(printing)) return undefined;
  if (!TOKEN.test(language)) return undefined;

  return { sourceKey, sourceId, condition, printing, language };
}

/** True when `value` is a code this hub could have written. */
export function isSkuCode(value: string | undefined | null): boolean {
  return parseSkuCode(value) !== undefined;
}
