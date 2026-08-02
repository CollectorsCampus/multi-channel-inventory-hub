import type { ListingMetafield } from '@hub/connector-sdk';
import { decodeJson } from '@hub/db';

/**
 * What a channel should put on the listings it creates, when the caller does
 * not say.
 *
 * Pure functions over a JSON-bearing `String` column, the way `sku-code.ts` and
 * `allocation.ts` are pure: everything here is parsing and judgement, and the
 * I/O lives in `ChannelsService`.
 *
 * ## Why this exists at all
 *
 * `ListingCreationService` applies tags, metafields and a category **verbatim**
 * and the hub may never derive one. That rule is not stylistic — every
 * collection on the store this was built for is a smart collection keyed on a
 * single tag equality rule, so a product carrying a tag the hub guessed exists
 * in the admin and appears nowhere in the shop, and nothing reports it. The
 * catalogue is no help either: it says `Pokemon` where the store's tag is
 * `Pokémon`, and `SV: Prismatic Evolutions` where the store has *both*
 * `SV085 Prismatic Evolutions` and `SV85 Prismatic Evolutions`.
 *
 * So an operator who wants stock listed without re-picking the same five
 * values per card has exactly one honest option: declare them once, per
 * channel, and have the hub repeat that declaration. This is that declaration.
 * It is still the operator's vocabulary, applied verbatim — the hub has just
 * stopped asking every time.
 */

export interface ChannelListingDefaults {
  /**
   * Applied to created products. An empty array is a real answer — "no tags" —
   * and is deliberately distinguishable from the key being absent.
   */
  tags?: string[];
  metafields?: ListingMetafield[];
  category?: string;
  vendor?: string;
}

/** Fields a stored default may carry. Anything else is dropped on read. */
const KNOWN_KEYS = ['tags', 'metafields', 'category', 'vendor'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetafield(raw: unknown): ListingMetafield | null {
  if (!isPlainObject(raw)) return null;

  const { owner, namespace, key, type, value } = raw;

  // Every field is required and must be a string: this is sent to a live
  // storefront, and a metafield missing its type or namespace is rejected by
  // the platform with a message naming neither.
  if (owner !== 'product' && owner !== 'variant') return null;
  if (typeof namespace !== 'string' || namespace === '') return null;
  if (typeof key !== 'string' || key === '') return null;
  if (typeof type !== 'string' || type === '') return null;
  if (typeof value !== 'string') return null;

  return { owner, namespace, key, type, value };
}

/**
 * Read a stored defaults column.
 *
 * Malformed entries are **dropped rather than thrown on**, for the reason
 * `decodeJson` gives: a corrupt column must not take down a request path. That
 * is safe here only because {@link hasDeclaredDefaults} is what gates automatic
 * listing — dropping a bad tag cannot silently produce an untagged product on a
 * storefront, because a defaults blob that parses to nothing stops the
 * automatic path before it calls the channel.
 */
export function parseListingDefaults(raw: string | null | undefined): ChannelListingDefaults {
  const decoded = decodeJson<unknown>(raw, {});
  if (!isPlainObject(decoded)) return {};

  const defaults: ChannelListingDefaults = {};

  if (Array.isArray(decoded.tags)) {
    defaults.tags = decoded.tags.filter((t): t is string => typeof t === 'string' && t !== '');
  }

  if (Array.isArray(decoded.metafields)) {
    defaults.metafields = decoded.metafields
      .map(parseMetafield)
      .filter((m): m is ListingMetafield => m !== null);
  }

  if (typeof decoded.category === 'string' && decoded.category !== '') {
    defaults.category = decoded.category;
  }

  if (typeof decoded.vendor === 'string' && decoded.vendor !== '') {
    defaults.vendor = decoded.vendor;
  }

  return defaults;
}

/** Serialise for storage. Round-trips through {@link parseListingDefaults}. */
export function encodeListingDefaults(defaults: ChannelListingDefaults): string {
  const stored: Record<string, unknown> = {};

  for (const key of KNOWN_KEYS) {
    const value = defaults[key];
    if (value !== undefined) stored[key] = value;
  }

  return JSON.stringify(stored);
}

/**
 * Has the operator actually said what a created product should carry?
 *
 * The gate on {@link ChannelInstance.autoListNewStock}, and the reason it is
 * "declared at all" rather than "has tags": requiring tags specifically would
 * be the hub deciding that every store organises by tag, which is true of the
 * store this was built for and is not a fact about storefronts. An operator who
 * genuinely wants no tags can save `{ tags: [] }` and that reads as the
 * deliberate answer it is.
 *
 * What this refuses is the case that actually bites — automatic creation
 * against a channel where nothing has ever been declared, which would put
 * untagged, uncategorised drafts on a storefront at the speed of intake.
 */
export function hasDeclaredDefaults(defaults: ChannelListingDefaults): boolean {
  return KNOWN_KEYS.some((key) => defaults[key] !== undefined);
}

/**
 * What the caller asked for, falling back to the channel's declaration.
 *
 * Per field, and `undefined` is the only thing that falls back: an explicit
 * empty array means "no tags on this run" and must not be quietly refilled from
 * the channel. That distinction is already how `ListingsController` treats the
 * request body, and it is the difference between a default and an override.
 */
export function applyListingDefaults<
  T extends {
    tags?: readonly string[];
    metafields?: readonly ListingMetafield[];
    category?: string;
    vendor?: string;
  },
>(request: T, defaults: ChannelListingDefaults): T {
  return {
    ...request,
    ...(request.tags === undefined && defaults.tags !== undefined ? { tags: defaults.tags } : {}),
    ...(request.metafields === undefined && defaults.metafields !== undefined
      ? { metafields: defaults.metafields }
      : {}),
    ...(request.category === undefined && defaults.category !== undefined
      ? { category: defaults.category }
      : {}),
    ...(request.vendor === undefined && defaults.vendor !== undefined
      ? { vendor: defaults.vendor }
      : {}),
  };
}
