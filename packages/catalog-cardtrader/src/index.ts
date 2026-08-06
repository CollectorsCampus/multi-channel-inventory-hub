/**
 * @hub/catalog-cardtrader — CardTrader as a `CatalogSource`.
 *
 * Read-only, pull side only — no `Connector` here. CardTrader's blueprints
 * carry `tcg_player_id`, `scryfall_id` and `card_market_ids`, so this converges
 * on the local catalog `@hub/catalog-tcgcsv` and `@hub/catalog-scryfall`
 * already built rather than duplicating it. See `cardtrader.ts` for what it
 * cannot do (no price, no printings) and why.
 *
 * The first catalog source needing authentication: `secretFields: ['token']`.
 */

export { CARDTRADER_SOURCE_KEY, createCardTraderSource } from './cardtrader';
export type { CardTraderSourceOptions, FetchLike } from './cardtrader';

export {
  CARDTRADER_KEY,
  toCandidate,
  toCandidates,
  type BlueprintLookup,
  type CtBlueprint,
  type CtEditableProperty,
  type CtExpansion,
  type CtGame,
} from './blueprints';
