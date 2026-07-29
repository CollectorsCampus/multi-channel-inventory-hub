/**
 * @hub/connector-shopify — Shopify Admin GraphQL connector.
 *
 * The only continuous-sync channel in v1 (ADR 0002).
 */

export {
  createShopifyConnector,
  SHOPIFY_CONNECTOR_KEY,
  priceToCents,
  centsToPrice,
} from './shopify';
export type { ShopifyConnectorOptions } from './shopify';
export {
  createShopifyClient,
  ShopifyError,
  ShopifyTransientError,
  SHOPIFY_API_VERSION,
} from './client';
export type { ShopifyClient, FetchLike } from './client';
export { createTokenSource } from './tokens';
export type { TokenSource } from './tokens';
