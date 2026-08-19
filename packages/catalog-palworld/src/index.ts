/**
 * @hub/catalog-palworld — Bushiroad's Palworld card database as a `CatalogSource`.
 *
 * Exists because no marketplace catalogue carries Palworld yet: the game
 * launched 2026-07-30 and TCGPlayer has opened no category, so tcgcsv has
 * nothing to republish and CardTrader does not list the game either.
 *
 * Read-only and unauthenticated. See `palworld.ts` for what it cannot do — no
 * prices, and no cross-references to converge on a future tcgcsv item — and why
 * that argues for using it at intake rather than bulk-ingesting a whole set.
 */

export { PALWORLD_SOURCE_KEY, createPalworldSource } from './palworld';
export type { PalworldSourceOptions, FetchLike } from './palworld';

export {
  PALWORLD_GAME,
  PALWORLD_KEY,
  cardName,
  flattenProducts,
  toCandidate,
  toCandidates,
  type PwCard,
  type PwListResponse,
  type PwProduct,
  type PwProductsResponse,
} from './cards';
