/**
 * Runtime source of truth for every closed value set in the Prisma schema.
 *
 * These are `String` columns rather than Prisma `enum`s. Not because enums are
 * unsupported on SQLite — Prisma 6.19+ maps them to TEXT there — but because
 * growing a native enum is a data-rewriting migration: Postgres needs
 * ALTER TYPE, and a MySQL ENUM change can rewrite the entire table. Value sets
 * like `status` and `kind` are expected to grow.
 *
 * The tradeoff is that the database no longer constrains these columns, so
 * every write path that sets one MUST validate through the guards below.
 */

export const ALLOCATION_MODES = ['fixed', 'pooled'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

export const ALLOCATION_STATUSES = ['draft', 'listed', 'error', 'delisted'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const SKU_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'SEALED', 'NA'] as const;
export type SkuCondition = (typeof SKU_CONDITIONS)[number];

/** Sentinel for "no special printing" — see Sku.printing in schema.prisma. */
export const DEFAULT_PRINTING = 'NORMAL';

export const CATALOG_SOURCES = ['tcgplayer', 'scryfall', 'shopify', 'manual'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

export const SYNC_DIRECTIONS = ['inbound', 'outbound', 'reconcile'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_ENTITY_TYPES = [
  'allocation',
  'order',
  'listing',
  'inventory',
  'channel',
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export const SYNC_OUTCOMES = ['pending', 'ok', 'error', 'conflict'] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

export const WEBHOOK_STATUSES = ['received', 'processed', 'failed', 'ignored'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export const STOCK_MOVEMENT_REASONS = [
  'intake',
  'sale',
  'adjustment',
  'return',
  'reconcile',
  'shrinkage',
] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

export const ALERT_KINDS = [
  'oversell',
  'sync_failure',
  'reconcile_drift',
  'auth_failure',
  'invariant_violation',
  // Raised by the repricing sweep when moves exceed the auto-apply threshold.
  // It was missing here until 2026-08-13, which did not stop the alert being
  // written (AlertsService takes a plain string) but did make the inbox's
  // `?kind=` filter reject it — the one kind you most want to filter to.
  'reprice_review',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const CHANNEL_HEALTH = ['unknown', 'ok', 'degraded', 'error'] as const;
export type ChannelHealth = (typeof CHANNEL_HEALTH)[number];

/** RBAC roles, ordered least → most privileged. */
export const USER_ROLES = ['viewer', 'editor', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AUTH_PROVIDER_KEYS = ['local', 'oidc'] as const;
export type AuthProviderKey = (typeof AUTH_PROVIDER_KEYS)[number];

/** True when `role` is at least as privileged as `required`. */
export function roleAtLeast(role: UserRole, required: UserRole): boolean {
  return USER_ROLES.indexOf(role) >= USER_ROLES.indexOf(required);
}

/** Builds a type guard for one of the `as const` tuples above. */
export function isOneOf<T extends readonly string[]>(
  values: T,
): (value: unknown) => value is T[number] {
  const set = new Set<string>(values);
  return (value: unknown): value is T[number] => typeof value === 'string' && set.has(value);
}

export const isAllocationMode = isOneOf(ALLOCATION_MODES);
export const isAllocationStatus = isOneOf(ALLOCATION_STATUSES);
export const isSkuCondition = isOneOf(SKU_CONDITIONS);
export const isUserRole = isOneOf(USER_ROLES);
export const isAlertKind = isOneOf(ALERT_KINDS);
export const isStockMovementReason = isOneOf(STOCK_MOVEMENT_REASONS);
