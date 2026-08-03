/**
 * A bigger version of a catalogue image, where the source publishes one.
 *
 * ## Why this is needed at all
 *
 * The catalogue stores exactly one image URL per item, and the sources chose it
 * for a thumbnail. tcgcsv's is **200 pixels wide** — fine at 44px in a result
 * list, useless for the thing an operator actually needs it for: deciding
 * whether this is the right printing before adding stock. Scaling 200px up to
 * card size produces a blur that answers nothing.
 *
 * Measured on 2026-08-02 rather than assumed, because most of the plausible
 * URLs 403:
 *
 * | Source     | Stored                | Enlarged                | Bytes         |
 * | ---------- | --------------------- | ----------------------- | ------------- |
 * | tcgcsv     | `565630_200w.jpg`     | `565630_in_1000x1000.jpg` | 14.6k → 184k |
 * | Scryfall   | `/normal/…`           | `/large/…`              | 58k → 89k     |
 *
 * `_1000x1000`, `_500x500` and the bare id all return **403** on the TCGPlayer
 * CDN, so this is a specific known grammar and not a general "swap the size in"
 * rule. Scryfall's `png` also exists at 665k, and is not used: it is a
 * different extension for a marginal gain over `large`.
 *
 * ## Why it lives in the browser
 *
 * This is display-time knowledge, not catalogue data. Doing it "properly" —
 * a `largeImageUrl` on `CatalogCandidate`, a column on `CatalogItem`, ingest
 * plumbing and a re-ingest to backfill — is the same shape as the deferred
 * collector-number change, and it would be an hour of migration to make a
 * viewer slightly sharper.
 *
 * The trade is safe because it **cannot fail visibly**: the caller uses this as
 * the `src` and falls back to the stored URL in `onError`, so an unknown host,
 * a changed CDN grammar or a 403 all degrade to exactly what would have been
 * shown anyway. Returning `null` for anything unrecognised is what keeps that
 * true — this never guesses.
 */

/** Hosts whose URL grammar has been checked against the live CDN. */
const SCRYFALL_HOST = 'cards.scryfall.io';
const TCGPLAYER_HOST = 'tcgplayer-cdn.tcgplayer.com';

/** The sizes Scryfall serves below `large`, and so the ones worth upgrading. */
const SCRYFALL_SMALLER = new Set(['small', 'normal']);

/**
 * A larger variant of `url`, or `null` when none is known.
 *
 * Null is not a failure: it means "show the stored image bigger", which is
 * still the right thing for a source whose only image is already full size.
 */
export function enlargedImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A relative or malformed URL. Nothing to reason about, and throwing here
    // would take down a list over a picture.
    return null;
  }

  if (parsed.hostname === SCRYFALL_HOST) {
    // `/normal/front/b/9/<id>.jpg` — the size is the first path segment, so it
    // is replaced positionally rather than by a substring swap that would also
    // rewrite an id happening to contain "normal".
    const segments = parsed.pathname.split('/');
    const size = segments[1];
    if (size !== undefined && SCRYFALL_SMALLER.has(size)) {
      segments[1] = 'large';
      parsed.pathname = segments.join('/');
      return parsed.toString();
    }
    return null;
  }

  if (parsed.hostname === TCGPLAYER_HOST) {
    // `/product/565630_200w.jpg`. Only a width-suffixed thumbnail is upgraded;
    // anything else is left alone, because the sizes that exist are a short
    // known list rather than a pattern.
    const upgraded = parsed.pathname.replace(/_\d+w\.jpg$/i, '_in_1000x1000.jpg');
    if (upgraded !== parsed.pathname) {
      parsed.pathname = upgraded;
      return parsed.toString();
    }
    return null;
  }

  return null;
}
