import { describe, expect, it } from 'vitest';
import {
  classifyChange,
  describeBasis,
  encodeRepricingPolicy,
  isRepricingActive,
  parseRepricingPolicy,
  roundTo99,
  targetPrice,
  type RepricingPolicy,
} from './repricing';

describe('parseRepricingPolicy', () => {
  it('round-trips a full policy', () => {
    const policy: RepricingPolicy = {
      enabled: true,
      conditionPercents: { NM: 100, LP: 85, SEALED: 100 },
      rounding: '99',
      floorCents: 49,
      autoApplyMaxPct: 10,
      minDeltaCents: 5,
    };
    expect(parseRepricingPolicy(encodeRepricingPolicy(policy))).toEqual(policy);
  });

  it('treats an empty column, malformed JSON and a non-object alike', () => {
    for (const raw of ['', '{', 'null', '[]', null, undefined]) {
      expect(parseRepricingPolicy(raw)).toEqual({});
    }
  });

  /**
   * An out-of-bounds percentage is dropped, never clamped: clamping would
   * reprice at a number the operator never typed, on a live storefront.
   */
  it('drops percentages the operator cannot have meant', () => {
    const raw = JSON.stringify({
      conditionPercents: { NM: 100, LP: 0, MP: -50, HP: 'cheap', DMG: 9000, '': 50 },
    });
    expect(parseRepricingPolicy(raw).conditionPercents).toEqual({ NM: 100 });
  });

  it('drops an unknown rounding rather than guessing one', () => {
    expect(parseRepricingPolicy('{"rounding":"95"}').rounding).toBeUndefined();
  });

  /**
   * Condition keys become property names, so they are allow-listed against
   * SKU_CONDITIONS — a request must not choose what gets written to, and
   * `__proto__` is the key that makes that concrete.
   */
  it('drops condition keys outside the SKU vocabulary, including __proto__', () => {
    const raw = JSON.stringify({
      conditionPercents: { NM: 100, MINT: 90, __proto__: 50, constructor: 50 },
    });
    const parsed = parseRepricingPolicy(raw);
    expect(parsed.conditionPercents).toEqual({ NM: 100 });
    expect(Object.getPrototypeOf(parsed.conditionPercents)).toBe(Object.prototype);
  });

  it('ignores unknown keys', () => {
    expect(parseRepricingPolicy('{"enabled":true,"marginTarget":2}')).toEqual({ enabled: true });
  });
});

describe('isRepricingActive', () => {
  it('needs both the switch and at least one declared percentage', () => {
    expect(isRepricingActive({})).toBe(false);
    expect(isRepricingActive({ enabled: true })).toBe(false);
    expect(isRepricingActive({ conditionPercents: { NM: 100 } })).toBe(false);
    expect(isRepricingActive({ enabled: true, conditionPercents: { NM: 100 } })).toBe(true);
  });
});

describe('targetPrice', () => {
  const policy: RepricingPolicy = {
    enabled: true,
    conditionPercents: { NM: 100, LP: 80 },
  };

  it('applies the condition percentage to the market figure', () => {
    expect(targetPrice(policy, 'NM', 1250)).toBe(1250);
    expect(targetPrice(policy, 'LP', 1250)).toBe(1000);
  });

  /**
   * The rule the whole module exists to honour: a condition the operator has
   * not declared is never repriced. No default multiplier — condition is most
   * of what a single is worth, and defaulting one is the software valuing the
   * card.
   */
  it('says nothing for an undeclared condition', () => {
    expect(targetPrice(policy, 'MP', 1250)).toBeUndefined();
    expect(targetPrice({}, 'NM', 1250)).toBeUndefined();
  });

  it('rounds to .99 when asked', () => {
    const rounded: RepricingPolicy = { ...policy, rounding: '99' };
    expect(targetPrice(rounded, 'NM', 1234)).toBe(1199);
    expect(targetPrice(rounded, 'NM', 1260)).toBe(1299);
  });

  it('never prices below the floor', () => {
    const floored: RepricingPolicy = { ...policy, floorCents: 49 };
    expect(targetPrice(floored, 'LP', 25)).toBe(49);
  });

  it('says nothing for a nonsense market price', () => {
    expect(targetPrice(policy, 'NM', 0)).toBeUndefined();
    expect(targetPrice(policy, 'NM', -5)).toBeUndefined();
    expect(targetPrice(policy, 'NM', Number.NaN)).toBeUndefined();
  });
});

describe('roundTo99', () => {
  it('takes the nearest x.99, ties upward', () => {
    expect(roundTo99(1234)).toBe(1199);
    expect(roundTo99(1260)).toBe(1299);
    // Exactly between 11.99 and 12.99 -> up.
    expect(roundTo99(1249)).toBe(1299);
    expect(roundTo99(1199)).toBe(1199);
  });

  it('never rounds below 99 cents', () => {
    // A 40-cent card has no x.99 beneath it; "minus 41 cents" is not rounding.
    expect(roundTo99(40)).toBe(99);
    expect(roundTo99(99)).toBe(99);
  });
});

describe('classifyChange', () => {
  const policy: RepricingPolicy = { autoApplyMaxPct: 10, minDeltaCents: 5 };

  it('skips no change and sub-threshold churn', () => {
    expect(classifyChange(policy, 1000, 1000).action).toBe('skip');
    expect(classifyChange(policy, 1000, 1003).action).toBe('skip');
  });

  it('auto-applies a move within the operator’s line', () => {
    const result = classifyChange(policy, 1000, 1080);
    expect(result.action).toBe('auto');
    expect(result.deltaPct).toBeCloseTo(8);
  });

  it('sends a huge move to review', () => {
    const result = classifyChange(policy, 1000, 1500);
    expect(result.action).toBe('review');
    expect(result.deltaPct).toBeCloseTo(50);
  });

  it('measures a drop the same as a rise', () => {
    expect(classifyChange(policy, 1000, 940).action).toBe('auto');
    expect(classifyChange(policy, 1000, 500).action).toBe('review');
  });

  /**
   * No threshold declared means nothing auto-applies. The safe reading of
   * "not configured" — the alternative silently moves prices on a storefront.
   */
  it('reviews everything when no auto threshold is set', () => {
    expect(classifyChange({}, 1000, 1001).action).toBe('review');
  });

  /**
   * An unpriced allocation has no base to measure a change against, and
   * first-pricing a live listing is exactly what a human should see.
   */
  it('always reviews an allocation with no current price', () => {
    expect(classifyChange(policy, null, 1000).action).toBe('review');
    expect(classifyChange(policy, 0, 1000).action).toBe('review');
  });
});

describe('describeBasis', () => {
  it('says how the number was arrived at, in the operator’s terms', () => {
    const policy: RepricingPolicy = {
      conditionPercents: { LP: 80 },
      rounding: '99',
      floorCents: 49,
    };
    expect(describeBasis(policy, 'LP', 1250)).toBe(
      'LP at 80% of market $12.50, rounded to .99, floor $0.49',
    );
  });
});
