import { TCGPLAYER_ID_KEY } from '@hub/catalog-tcgcsv';
import type { CatalogCandidate } from '@hub/connector-sdk';

/**
 * Shapes and mapping for CardTrader's `/games`, `/expansions` and
 * `/blueprints/export` endpoints — read-only GETs, and this is only the
 * catalogue half of the API (ADR 0002 / `docs/CONNECTOR_ROADMAP.md`).
 *
 * Pure functions over already-parsed JSON — no HTTP, no clock — so every shape
 * below is pinned by a fixture rather than a live call. The fixtures are typed
 * literals modelled on real responses read on 2026-08-03 with the operator's
 * own token (`private/cardtrader/`), not scraped text.
 */

export const CARDTRADER_KEY = 'cardtrader';

/** Matches `@hub/catalog-scryfall`'s `SCRYFALL_KEY` — not imported just for a string. */
const SCRYFALL_ID_KEY = 'scryfall';

/** Cardmarket's own product id. No catalog source for Cardmarket exists yet. */
const CARDMARKET_ID_KEY = 'cardmarket';

export interface CtGame {
  id: number;
  name: string;
  display_name: string;
}

export interface CtExpansion {
  id: number;
  game_id: number;
  code: string;
  name: string;
}

export interface CtEditableProperty {
  name: string;
}

/**
 * One product CardTrader knows about.
 *
 * Deliberately not the full response shape — `image`, `back_image` and the
 * rest of `editable_properties` carry nothing this source uses. Adding fields
 * nothing reads would just be more surface to keep in sync with an API this
 * package does not control.
 */
export interface CtBlueprint {
  id: number;
  name: string;
  /** A variant qualifier — "Holo Rare | 1/102" for a single, absent for most sealed product. */
  version: string | null;
  game_id: number;
  expansion_id: number;
  image_url: string | null;
  /**
   * Declares the fields a listing on this blueprint can carry. **Its presence
   * is the signal this source uses for "is this a single or sealed product"** —
   * verified across two games' real exports (a Magic set and a Pokémon set):
   * every single declares `condition`, and not one sealed product does, even
   * where the game also has a `sealed` boolean of its own. There is no
   * separate `is_sealed` field to read instead.
   */
  editable_properties: readonly CtEditableProperty[];
  /**
   * Plural in CardTrader's own schema — one blueprint can carry more than one
   * Cardmarket id. Only the first is kept; `CatalogCandidate.externalIds` has
   * room for one value per namespace, and nothing here has needed the rest.
   */
  card_market_ids: readonly number[] | null;
  tcg_player_id: number | null;
  scryfall_id: string | null;
}

/**
 * Map games and expansions to lookup functions, the same shape
 * `@hub/catalog-tcgcsv`'s `toCandidates` takes for categories and groups.
 */
export interface BlueprintLookup {
  gameName?: (gameId: number) => string | undefined;
  expansionName?: (expansionId: number) => string | undefined;
}

/**
 * One blueprint, one candidate — unlike tcgcsv, which groups several
 * per-printing rows into one product. A CardTrader blueprint already *is* one
 * specific product: a foil and non-foil printing of the same card are two
 * separate blueprint ids, not two rows of one.
 *
 * **No `marketPrice`, ever.** `/blueprints/export` carries no price at all —
 * pricing lives on `/marketplace/products`, a *listing* endpoint keyed on
 * blueprint id, not a catalogue one. tcgcsv's `ProductsAndPrices.csv` genuinely
 * has both; CardTrader's catalogue does not, and this must not be papered over
 * with a second network call from inside a mapping function.
 *
 * **No `printings`, deliberately.** tcgcsv's `printings` is an enum of finish
 * names; CardTrader instead exposes a set of independent booleans per game
 * (`mtg_foil`, `first_edition`, …) with no shared vocabulary across games to
 * normalise them into. Guessing one would be inventing data this source does
 * not actually have.
 */
export function toCandidate(
  blueprint: CtBlueprint,
  lookup: BlueprintLookup = {},
): CatalogCandidate {
  const name = blueprint.version ? `${blueprint.name} - ${blueprint.version}` : blueprint.name;

  const externalIds: Record<string, string> = { [CARDTRADER_KEY]: String(blueprint.id) };
  if (blueprint.tcg_player_id != null) {
    // The convergence key: present on 92-100% of blueprints in every game
    // measured, and the same id space tcgcsv and Scryfall both write to
    // `CatalogExternalRef` — so `IntakeService.resolveCatalogItem`'s `OR`
    // across a candidate's externalIds finds the existing item by design,
    // not by luck the way two sources both happening to emit `tcgplayer` is.
    externalIds[TCGPLAYER_ID_KEY] = String(blueprint.tcg_player_id);
  }
  if (blueprint.scryfall_id) externalIds[SCRYFALL_ID_KEY] = blueprint.scryfall_id;
  const cardmarketId = blueprint.card_market_ids?.[0];
  if (cardmarketId != null) externalIds[CARDMARKET_ID_KEY] = String(cardmarketId);

  const candidate: CatalogCandidate = { sourceId: String(blueprint.id), name, externalIds };

  const game = lookup.gameName?.(blueprint.game_id);
  if (game) candidate.game = game;

  const setName = lookup.expansionName?.(blueprint.expansion_id);
  if (setName) candidate.setName = setName;

  if (blueprint.image_url) candidate.imageUrl = blueprint.image_url;

  return candidate;
}

export function toCandidates(
  blueprints: readonly CtBlueprint[],
  lookup: BlueprintLookup = {},
): CatalogCandidate[] {
  return blueprints.map((b) => toCandidate(b, lookup));
}
