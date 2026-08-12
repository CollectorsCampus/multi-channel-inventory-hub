import { SKU_CONDITIONS, decodeJson } from '@hub/db';

/**
 * Repricing policy: how a channel turns a market price into an asking price,
 * and which changes are safe to apply without a human.
 *
 * Pure functions over a JSON-bearing `String` column, the way
 * `listing-defaults.ts` and `allocation.ts` are pure. The I/O — fetching
 * market prices, writing allocations, queueing pushes — lives in
 * `RepriceService`.
 *
 * ## The hub never invents a percentage
 *
 * Nothing is repriced until the operator has said what each condition is worth
 * relative to market. There are no default multipliers: a default would be the
 * software deciding that a Lightly Played copy is worth some fraction of a
 * Near Mint one, and condition is most of what a single is worth — the same
 * reason `deriveSkuDimensions` refuses to default a condition. A condition
 * with no declared percentage is simply never repriced.
 *
 * ## Auto against review
 *
 * The operator's own framing: reprice automatically, but a huge change gets
 * confirmed by a human. `autoApplyMaxPct` is that line. It is **absent by
 * default**, and an absent line means *everything* goes to review — the safe
 * reading of "not configured", since the alternative silently moves prices on
 * a live storefront.
 */

export interface RepricingPolicy {
  /** The master switch. Off (or absent) means the sweep records prices but touches nothing. */
  enabled?: boolean;
  /**
   * Percent of market each condition sells at (100 = at market). A condition
   * absent here is never repriced. Keys are `Sku.condition` tokens; `SEALED`
   * works like any other, and a key outside `SKU_CONDITIONS` is dropped on
   * read — it could never fire, and property names must not come off a
   * request body unchecked.
   */
  conditionPercents?: Record<string, number>;
  /** Round the computed price to the nearest x.99, or leave it exact. */
  rounding?: 'none' | '99';
  /** Never price below this, in cents. */
  floorCents?: number;
  /**
   * Largest percentage move (relative to the current price) applied without a
   * human. Absent means every change is queued for review.
   */
  autoApplyMaxPct?: number;
  /** Ignore moves smaller than this many cents, so prices do not churn. */
  minDeltaCents?: number;
  /**
   * Only reprice items physically held. Zero-stock (and oversold-negative)
   * items are skipped — market figures are still recorded for them, so the
   * catalogue stays current, but their asking prices are not churned while
   * there is nothing to sell.
   */
  inStockOnly?: boolean;
}

const ROUNDINGS = ['none', '99'] as const;

/** Percent bounds: 0 exclusive (a 0% price is a free card), 500 as a sanity cap. */
const MIN_PERCENT = 0;
const MAX_PERCENT = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a stored policy column. Malformed parts are dropped rather than thrown
 * on, exactly as `parseListingDefaults` does — and dropping is safe here for
 * the same structural reason: a policy that parses to nothing reprices
 * nothing.
 */
export function parseRepricingPolicy(raw: string | null | undefined): RepricingPolicy {
  const decoded = decodeJson<unknown>(raw, {});
  if (!isPlainObject(decoded)) return {};

  const policy: RepricingPolicy = {};

  if (typeof decoded.enabled === 'boolean') policy.enabled = decoded.enabled;
  if (typeof decoded.inStockOnly === 'boolean') policy.inStockOnly = decoded.inStockOnly;

  if (isPlainObject(decoded.conditionPercents)) {
    const percents: Record<string, number> = {};
    // Keys come off a request body and become property names, so they are
    // allow-listed against the closed SKU_CONDITIONS vocabulary rather than
    // taken as strings — the same remote-property-injection finding CodeQL
    // made against matching's candidate keys, and it is right again: without
    // this, `__proto__` is a writable key. Nothing of value is lost, because
    // a percentage for a condition no Sku can carry could never fire anyway.
    for (const condition of SKU_CONDITIONS) {
      const percent = asFiniteNumber(decoded.conditionPercents[condition]);
      // An out-of-bounds percentage is a rule that must not fire, not one to
      // clamp: clamping would reprice at a number the operator never typed.
      if (percent !== undefined && percent > MIN_PERCENT && percent <= MAX_PERCENT) {
        percents[condition] = percent;
      }
    }
    if (Object.keys(percents).length > 0) policy.conditionPercents = percents;
  }

  if (
    typeof decoded.rounding === 'string' &&
    (ROUNDINGS as readonly string[]).includes(decoded.rounding)
  ) {
    policy.rounding = decoded.rounding as (typeof ROUNDINGS)[number];
  }

  const floor = asFiniteNumber(decoded.floorCents);
  if (floor !== undefined && floor >= 0) policy.floorCents = Math.round(floor);

  const autoPct = asFiniteNumber(decoded.autoApplyMaxPct);
  if (autoPct !== undefined && autoPct >= 0) policy.autoApplyMaxPct = autoPct;

  const minDelta = asFiniteNumber(decoded.minDeltaCents);
  if (minDelta !== undefined && minDelta >= 0) policy.minDeltaCents = Math.round(minDelta);

  return policy;
}

/** Serialise for storage. Round-trips through {@link parseRepricingPolicy}. */
export function encodeRepricingPolicy(policy: RepricingPolicy): string {
  const stored: Record<string, unknown> = {};
  if (policy.enabled !== undefined) stored.enabled = policy.enabled;
  if (policy.conditionPercents !== undefined) stored.conditionPercents = policy.conditionPercents;
  if (policy.rounding !== undefined) stored.rounding = policy.rounding;
  if (policy.floorCents !== undefined) stored.floorCents = policy.floorCents;
  if (policy.autoApplyMaxPct !== undefined) stored.autoApplyMaxPct = policy.autoApplyMaxPct;
  if (policy.minDeltaCents !== undefined) stored.minDeltaCents = policy.minDeltaCents;
  if (policy.inStockOnly !== undefined) stored.inStockOnly = policy.inStockOnly;
  return JSON.stringify(stored);
}

/** Can this policy reprice anything at all? */
export function isRepricingActive(policy: RepricingPolicy): boolean {
  return (
    policy.enabled === true &&
    policy.conditionPercents !== undefined &&
    Object.keys(policy.conditionPercents).length > 0
  );
}

/**
 * What the policy says this SKU should sell for, in cents.
 *
 * Undefined when the policy has nothing to say — condition not declared, or
 * the computation bottoms out at zero. Never negative, never below the floor.
 */
export function targetPrice(
  policy: RepricingPolicy,
  condition: string,
  marketCents: number,
): number | undefined {
  const percent = policy.conditionPercents?.[condition];
  if (percent === undefined) return undefined;
  if (!Number.isFinite(marketCents) || marketCents <= 0) return undefined;

  let cents = Math.round((marketCents * percent) / 100);

  if (policy.rounding === '99') cents = roundTo99(cents);

  if (policy.floorCents !== undefined && cents < policy.floorCents) {
    cents = policy.floorCents;
  }

  return cents > 0 ? cents : undefined;
}

/**
 * The nearest x.99, ties upward — 12.34 becomes 11.99, 12.60 becomes 12.99.
 *
 * Below 99 cents there is no x.99 beneath the value, so everything rounds up
 * to 99: pricing a 40-cent card at "minus 41 cents" is not a rounding.
 */
export function roundTo99(cents: number): number {
  const below = Math.floor(cents / 100) * 100 - 1;
  const above = below + 100;
  if (below < 99) return 99;
  return cents - below < above - cents ? below : above;
}

export type RepriceAction = 'skip' | 'auto' | 'review';

/**
 * Whether a computed target is applied, queued for a human, or ignored.
 *
 * - Unchanged (or within `minDeltaCents`) is a **skip** — prices must not
 *   churn on noise.
 * - An allocation with **no current price** always goes to review: there is no
 *   base to measure "how big is this change" against, and first-pricing a live
 *   listing is exactly the kind of move a human should see.
 * - Otherwise the move's size relative to the current price decides, against
 *   `autoApplyMaxPct` — absent means review, the safe reading of
 *   "not configured".
 */
export function classifyChange(
  policy: RepricingPolicy,
  currentCents: number | null,
  targetCents: number,
): { action: RepriceAction; deltaPct?: number } {
  if (currentCents === null || currentCents <= 0) {
    return { action: 'review' };
  }

  const delta = Math.abs(targetCents - currentCents);
  if (delta === 0) return { action: 'skip' };
  if (policy.minDeltaCents !== undefined && delta < policy.minDeltaCents) {
    return { action: 'skip' };
  }

  const deltaPct = (delta / currentCents) * 100;

  if (policy.autoApplyMaxPct !== undefined && deltaPct <= policy.autoApplyMaxPct) {
    return { action: 'auto', deltaPct };
  }
  return { action: 'review', deltaPct };
}

/** How the number was arrived at, in the operator's terms — stored on the proposal. */
export function describeBasis(
  policy: RepricingPolicy,
  condition: string,
  marketCents: number,
): string {
  const percent = policy.conditionPercents?.[condition];
  const parts = [`${condition} at ${percent ?? '?'}% of market $${(marketCents / 100).toFixed(2)}`];
  if (policy.rounding === '99') parts.push('rounded to .99');
  if (policy.floorCents !== undefined) {
    parts.push(`floor $${(policy.floorCents / 100).toFixed(2)}`);
  }
  return parts.join(', ');
}
