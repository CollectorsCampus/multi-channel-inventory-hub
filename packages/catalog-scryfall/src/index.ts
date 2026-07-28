/**
 * @hub/catalog-scryfall — Scryfall as a `CatalogSource`.
 *
 * Not a `Connector`: Scryfall is a product database, not a sales channel. It
 * has no listings, no orders and no place in the allocation loop.
 */

export { createScryfallSource, SCRYFALL_KEY } from './scryfall';
export type { ScryfallSourceOptions, FetchLike } from './scryfall';
export { usdStringToCents } from './money';
