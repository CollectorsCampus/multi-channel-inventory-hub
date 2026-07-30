/**
 * @hub/catalog-tcgcsv — tcgcsv.com as a `CatalogSource`.
 *
 * TCGPlayer's product catalogue for the 90 categories tcgcsv publishes, which is
 * everything a real card inventory contains rather than just Magic. Not a
 * `Connector`: it has no listings, no orders and no place in the allocation loop.
 *
 * **Prices here are per product and printing, never per condition** — tcgcsv does
 * not publish the SKU tier. See `tcgcsv.ts` for what that rules out.
 */

export { TCGCSV_SOURCE_KEY, createTcgcsvSource } from './tcgcsv';
export type { FetchLike, TcgcsvSourceOptions } from './tcgcsv';

export {
  TCGCSV_KEY,
  TCGPLAYER_ID_KEY,
  looseIncludes,
  normalizePrinting,
  parseCategories,
  parseGroups,
  parseProductsAndPrices,
  toCandidates,
  type TcgcsvCategory,
  type TcgcsvGroup,
  type TcgcsvProductRow,
} from './rows';
