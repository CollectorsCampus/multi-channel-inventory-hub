/**
 * @hub/connector-shopify — Shopify Admin GraphQL connector.
 *
 * Phase 0 placeholder. Implementation lands in Phase 3: outbound push first,
 * then HMAC-verified inbound webhooks for `orders/create` and
 * `inventory_levels/update` (TECHNICAL_DESIGN.md §5, §11).
 *
 * Note for the implementer: Shopify inventory is location-scoped. This
 * connector's config must carry a single `locationId`, and v1 deliberately
 * ignores every other location on the shop — the core data model has one
 * InventoryItem per SKU with no location dimension.
 */

export const SHOPIFY_CONNECTOR_KEY = 'shopify';
