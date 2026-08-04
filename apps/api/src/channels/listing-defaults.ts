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
 * ## Why a flat list per channel was not enough
 *
 * The first version of this stored one list of tags per channel. That is only
 * ever right for a single-game, single-set session: a store's tags are
 * `Pokémon`, `SV04 Paradox Rift` and `Elite Trainer Box`, and **all three vary
 * per card**. Two cards from different games added in one sitting would both
 * get whichever tags the channel happened to hold, and on a tag-driven store
 * that puts one of them in a collection it does not belong in.
 *
 * {@link ChannelListingDefaults.tagRules} replaces it: the operator maps a fact
 * the ledger already holds — game, set, or a phrase in the name — onto a tag
 * they picked from the store's own vocabulary, once. The hub still invents
 * nothing; it has been told the mapping instead of being asked for it per card.
 *
 * The remaining fields are genuinely per channel. A category is one
 * classification for everything this channel creates, and a vendor is usually
 * one publisher — where it is not, a rule-shaped answer would be the same
 * extension as tags took.
 */

/**
 * What a rule looks at. Only facts the ledger already holds about a card.
 *
 * - `game` and `set` compare **exactly** against `CatalogItem.game` /
 *   `setName`, because the operator picks those values from what the catalogue
 *   actually stores rather than typing them. An exact comparison is then
 *   predictable, and predictability is what makes a rule safe to leave running.
 * - `name-contains` is the escape hatch for the one thing the hub does *not*
 *   model — what kind of product it is. "Elite Trainer Box" and "Booster Pack"
 *   exist only inside the product name, so this matches a substring, and
 *   case-insensitively because it is typed by hand.
 * - `kind` is the one fact the hub genuinely derives rather than stores: is
 *   this a single, sealed product, or neither. See {@link itemKind} for why
 *   that is safe when deriving a *tag* is not.
 */
export type TagRuleMatch = 'game' | 'set' | 'name-contains' | 'kind';

export const TAG_RULE_MATCHES: readonly TagRuleMatch[] = ['game', 'set', 'name-contains', 'kind'];

/**
 * What sort of thing an item is, as far as the hub can tell.
 *
 * Three values rather than two, because "not a single" is not one fact. `NA`
 * means *not applicable* — what a binder, a playmat or a Funko Pop has — and
 * tagging one of those "Sealed" would put it in a collection of booster boxes.
 */
export type ItemKind = 'single' | 'sealed' | 'other';

export const ITEM_KINDS: readonly ItemKind[] = ['single', 'sealed', 'other'];

/**
 * Which of the three an item is, from its SKU condition.
 *
 * **This is the one place that decides**, and `ListingCreationService` reads it
 * rather than keeping its own copy: the same distinction already decides
 * whether a created product gets a `Condition` variant option and whether its
 * title carries the set. A second answer to "is this a single" would eventually
 * disagree with the first, and the symptom would be a product tagged as a
 * single that has no condition option — visibly incoherent on a storefront and
 * traceable to neither half.
 *
 * Note this derives a *classification*, never a tag. The hub still invents no
 * tag: the operator maps this fact onto a tag from their own vocabulary, the
 * same as they do for game and set. That is the distinction the whole rules
 * system rests on.
 */
export function itemKind(condition: string): ItemKind {
  if (condition === 'SEALED') return 'sealed';
  if (condition === 'NA') return 'other';
  return 'single';
}

export interface TagRule {
  match: TagRuleMatch;
  /** The catalogue value to look for. For `kind`, one of {@link ITEM_KINDS}. */
  value: string;
  /** The channel's own tag, applied verbatim. */
  tag: string;
}

/** The facts a rule may be evaluated against. */
export interface TaggableItem {
  name: string;
  game?: string | null;
  setName?: string | null;
  /**
   * The SKU's condition, for a `kind` rule. Absent means the caller cannot say,
   * and a `kind` rule then matches nothing rather than guessing `single` —
   * which would tag every sealed box on a channel whose only rule is "Singles".
   */
  condition?: string | null;
}

export interface ChannelListingDefaults {
  /**
   * Applied to **every** created product, whatever it is. An empty array is a
   * real answer — "no unconditional tags" — and is deliberately distinguishable
   * from the key being absent.
   *
   * Usually empty in practice. Almost every tag a real store uses varies by
   * game, set or kind of product, which is what {@link tagRules} is for.
   */
  tags?: string[];
  /**
   * Applied to a created product when they match it.
   *
   * This is the answer to the thing a flat `tags` list gets wrong: a store's
   * tags are `Pokémon`, `SV04 Paradox Rift` and `Elite Trainer Box`, and all
   * three differ per card, so one list per channel can only ever be right for a
   * single-game, single-set session.
   *
   * It does **not** loosen "the hub never derives a tag". Every tag here is one
   * the operator chose from the store's own vocabulary; the rule only says
   * which cards it applies to, using facts the ledger already holds. The hub
   * still invents nothing — it has just been told the mapping once instead of
   * being asked for it per card.
   */
  tagRules?: TagRule[];
  metafields?: ListingMetafield[];
  category?: string;
  vendor?: string;
}

/** Fields a stored default may carry. Anything else is dropped on read. */
const KNOWN_KEYS = ['tags', 'tagRules', 'metafields', 'category', 'vendor'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTagRule(raw: unknown): TagRule | null {
  if (!isPlainObject(raw)) return null;

  const { match, value, tag } = raw;

  // A rule missing any part cannot be evaluated, and a blank tag would put a
  // product in no collection while looking configured. Dropped rather than
  // repaired: there is no sensible repair.
  if (typeof match !== 'string' || !(TAG_RULE_MATCHES as readonly string[]).includes(match)) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (typeof tag !== 'string' || tag.trim() === '') return null;

  // A `kind` rule's value is a closed vocabulary this code owns, not a
  // catalogue string, so an unrecognised one is a rule that can never fire.
  // Dropped like any other unevaluable rule rather than defaulted to `single`,
  // which would silently tag sealed product as singles.
  if (match === 'kind' && !(ITEM_KINDS as readonly string[]).includes(value.trim())) {
    return null;
  }

  return { match: match as TagRuleMatch, value: value.trim(), tag: tag.trim() };
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

  if (Array.isArray(decoded.tagRules)) {
    defaults.tagRules = decoded.tagRules.map(parseTagRule).filter((r): r is TagRule => r !== null);
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

/** Does this rule apply to this card? */
export function tagRuleMatches(rule: TagRule, item: TaggableItem): boolean {
  switch (rule.match) {
    case 'game':
      // Exact: the value came from the catalogue, not from typing.
      return item.game === rule.value;
    case 'set':
      return item.setName === rule.value;
    case 'name-contains':
      return item.name.toLowerCase().includes(rule.value.toLowerCase());
    case 'kind':
      // No condition means the caller could not say what this is. Matching
      // nothing is the safe answer: the alternative is assuming `single`, and
      // a channel whose only rule is "Singles" would then tag every sealed
      // box it created.
      return item.condition != null && itemKind(item.condition) === rule.value;
  }
}

/**
 * Every tag a created product should carry, for this card.
 *
 * Unconditional tags first, then whichever rules match, in the order the
 * operator arranged them — a store's tags are read by people as well as by
 * collection rules, and a set that reshuffles per card looks like a bug.
 *
 * Deduplicated, because two rules legitimately arriving at the same tag (a
 * game rule and a name rule both saying `Pokémon`) is a configuration worth
 * tolerating rather than an error worth refusing.
 */
export function resolveTags(defaults: ChannelListingDefaults, item: TaggableItem): string[] {
  const matched = (defaults.tagRules ?? [])
    .filter((rule) => tagRuleMatches(rule, item))
    .map((rule) => rule.tag);

  return [...new Set([...(defaults.tags ?? []), ...matched])];
}

/**
 * What the caller asked for, falling back to the channel's declaration.
 *
 * Per field, and `undefined` is the only thing that falls back: an explicit
 * empty array means "none on this run" and must not be quietly refilled from
 * the channel. That distinction is already how `ListingsController` treats the
 * request body, and it is the difference between a default and an override.
 *
 * **Tags are deliberately not handled here.** They are the one field that
 * depends on *which card* is being created, so they are resolved per item by
 * {@link resolveTags} rather than once per run. A run may still override them
 * wholesale, and `ListingCreationService` is where those two meet.
 */
export function applyListingDefaults<
  T extends {
    metafields?: readonly ListingMetafield[];
    category?: string;
    vendor?: string;
  },
>(request: T, defaults: ChannelListingDefaults): T {
  return {
    ...request,
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
