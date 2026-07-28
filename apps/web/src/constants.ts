/**
 * Deliberately duplicated from packages/db/src/enums.ts rather than imported.
 *
 * @hub/db re-exports the generated Prisma client, which pulls Node built-ins
 * and the query engine into whatever imports it — none of which can run in a
 * browser. Until these value sets are split into a browser-safe package, a
 * small copy is cheaper than shipping the ORM to the client.
 *
 * The server is authoritative: every one of these is validated again by the
 * API's DTOs, so a copy that drifts produces a 400, not bad data.
 */

export const SKU_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'SEALED', 'NA'] as const;

export const STOCK_MOVEMENT_REASONS = ['intake', 'adjustment', 'return', 'shrinkage'] as const;

export const ALLOCATION_MODES = ['fixed', 'pooled'] as const;
