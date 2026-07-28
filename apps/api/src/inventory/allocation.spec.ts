import { describe, expect, it } from 'vitest';
import {
  applySale,
  computeAllListedQuantities,
  computeListedQuantity,
  computePool,
  isLedgerValid,
  sumFixedPartitions,
  unallocatedQuantity,
  validateLedger,
  type AllocationView,
  type LedgerView,
} from './allocation';

// --- builders ---------------------------------------------------------------

function fixed(id: string, quantityAllocated: number): AllocationView {
  return {
    id,
    channelInstanceId: `chan-${id}`,
    mode: 'fixed',
    quantityAllocated,
    maxQuantity: null,
  };
}

function pooled(id: string, maxQuantity: number | null = null): AllocationView {
  return {
    id,
    channelInstanceId: `chan-${id}`,
    mode: 'pooled',
    quantityAllocated: null,
    maxQuantity,
  };
}

function ledger(
  quantityOnHand: number,
  allocations: AllocationView[] = [],
  reserveQuantity = 0,
): LedgerView {
  return { quantityOnHand, reserveQuantity, allocations };
}

const listed = (l: LedgerView) => Object.fromEntries(computeAllListedQuantities(l));

// --- the design document's worked examples ----------------------------------

describe('TECHNICAL_DESIGN.md §4 worked examples', () => {
  it('fixed: 10 on hand -> 6 Shopify, 3 TCGPlayer, 1 unallocated', () => {
    const l = ledger(10, [fixed('shopify', 6), fixed('tcg', 3)]);

    expect(listed(l)).toEqual({ shopify: 6, tcg: 3 });
    expect(unallocatedQuantity(l)).toBe(1);
    expect(isLedgerValid(l)).toBe(true);
  });

  it('pooled: 10 on hand, Shopify capped at 5, TCGPlayer uncapped -> lists 5 and 10', () => {
    const l = ledger(10, [pooled('shopify', 5), pooled('tcg')]);

    // The same ten physical units advertised twice over. Intentional.
    expect(listed(l)).toEqual({ shopify: 5, tcg: 10 });
  });

  it('a capped channel only shrinks once the pool falls below its cap', () => {
    const cap = 5;
    const at = (onHand: number) =>
      computeListedQuantity(
        pooled('shopify', cap),
        computePool(ledger(onHand, [pooled('shopify', cap)])),
      );

    expect(at(10)).toBe(5);
    expect(at(6)).toBe(5);
    expect(at(5)).toBe(5);
    expect(at(4)).toBe(4);
    expect(at(0)).toBe(0);
  });

  it('reserveQuantity is removed from the pool before any pooled math', () => {
    const l = ledger(10, [pooled('shopify'), pooled('tcg', 8)], 3);

    expect(computePool(l)).toBe(7);
    expect(listed(l)).toEqual({ shopify: 7, tcg: 7 });
  });

  it('mixes modes on one SKU', () => {
    // 10 on hand, 4 committed to a fixed channel, 1 reserved -> pool of 5.
    const l = ledger(10, [fixed('tcg', 4), pooled('shopify'), pooled('ebay', 2)], 1);

    expect(computePool(l)).toBe(5);
    expect(listed(l)).toEqual({ tcg: 4, shopify: 5, ebay: 2 });
  });
});

// --- derivation edge cases --------------------------------------------------

describe('pool derivation', () => {
  it('clamps at zero rather than going negative', () => {
    // Inconsistent state: more committed than exists.
    const l = ledger(5, [fixed('tcg', 6)]);

    expect(computePool(l)).toBe(0);
    expect(listed(l)).toMatchObject({ tcg: 6 });
    expect(isLedgerValid(l)).toBe(false);
  });

  it('treats a pooled cap of zero as "list nothing"', () => {
    expect(listed(ledger(10, [pooled('paused', 0)]))).toEqual({ paused: 0 });
  });

  it('ignores pooled allocations when summing partitions', () => {
    expect(sumFixedPartitions([fixed('a', 3), pooled('b'), fixed('c', 2)])).toBe(5);
  });

  it('handles an item with no allocations at all', () => {
    const l = ledger(7);
    expect(computePool(l)).toBe(7);
    expect(unallocatedQuantity(l)).toBe(7);
    expect(listed(l)).toEqual({});
  });
});

// --- validation -------------------------------------------------------------

describe('validateLedger', () => {
  it('accepts a ledger sitting exactly on the invariant boundary', () => {
    expect(isLedgerValid(ledger(10, [fixed('a', 7)], 3))).toBe(true);
  });

  it('rejects committing one more unit than exists', () => {
    const issues = validateLedger(ledger(10, [fixed('a', 8)], 3));
    expect(issues.map((i) => i.code)).toContain('over_allocated');
    expect(issues.find((i) => i.code === 'over_allocated')?.message).toMatch(
      /exceeds the 10 on hand/,
    );
  });

  it('rejects negative quantities', () => {
    expect(validateLedger(ledger(-1)).map((i) => i.code)).toContain('negative_on_hand');
    expect(validateLedger(ledger(5, [], -1)).map((i) => i.code)).toContain('negative_reserve');
    expect(validateLedger(ledger(5, [fixed('a', -1)])).map((i) => i.code)).toContain(
      'fixed_negative_quantity',
    );
    expect(validateLedger(ledger(5, [pooled('a', -1)])).map((i) => i.code)).toContain(
      'pooled_negative_max',
    );
  });

  it('rejects fractional quantities', () => {
    expect(validateLedger(ledger(1.5)).map((i) => i.code)).toContain('non_integer_quantity');
    expect(validateLedger(ledger(5, [fixed('a', 1.5)])).map((i) => i.code)).toContain(
      'non_integer_quantity',
    );
  });

  it('requires a fixed allocation to declare its partition', () => {
    const orphan: AllocationView = {
      id: 'a',
      channelInstanceId: 'chan-a',
      mode: 'fixed',
      quantityAllocated: null,
      maxQuantity: null,
    };
    expect(validateLedger(ledger(5, [orphan])).map((i) => i.code)).toContain(
      'fixed_missing_quantity',
    );
  });

  it('rejects fields belonging to the other mode', () => {
    const pooledWithPartition: AllocationView = {
      id: 'a',
      channelInstanceId: 'chan-a',
      mode: 'pooled',
      quantityAllocated: 3,
      maxQuantity: null,
    };
    expect(validateLedger(ledger(5, [pooledWithPartition])).map((i) => i.code)).toContain(
      'pooled_has_partition',
    );

    const fixedWithCap: AllocationView = {
      id: 'b',
      channelInstanceId: 'chan-b',
      mode: 'fixed',
      quantityAllocated: 2,
      maxQuantity: 4,
    };
    expect(validateLedger(ledger(5, [fixedWithCap])).map((i) => i.code)).toContain(
      'fixed_has_max_quantity',
    );
  });

  it('reports every problem at once, so the editor can show them together', () => {
    const issues = validateLedger(ledger(-2, [fixed('a', -1), pooled('b', -5)], -3));
    expect(new Set(issues.map((i) => i.code))).toEqual(
      new Set([
        'negative_on_hand',
        'negative_reserve',
        'fixed_negative_quantity',
        'pooled_negative_max',
      ]),
    );
  });
});

// --- sales ------------------------------------------------------------------

describe('applySale on a fixed channel', () => {
  it('consumes only its own partition, plus on-hand', () => {
    const l = ledger(10, [fixed('shopify', 6), fixed('tcg', 3)]);
    const { next, conflicts } = applySale(l, 'shopify', 2);

    expect(next.quantityOnHand).toBe(8);
    expect(next.allocations.find((a) => a.id === 'shopify')?.quantityAllocated).toBe(4);
    expect(next.allocations.find((a) => a.id === 'tcg')?.quantityAllocated).toBe(3);
    expect(conflicts).toEqual([]);
  });

  /**
   * §6 step 3 says a fixed sale fans out "to every channel whose listed value
   * changed ... via the pool", which reads as though pooled channels follow a
   * fixed sale down. They do not, and cannot: on-hand and the partition both
   * fall by the sale quantity, so `onHand − Σfixed − reserve` is unchanged by
   * construction. A fixed sale costs exactly one outbound push, not N.
   */
  it('leaves pooled channels untouched, because the pool does not move', () => {
    const l = ledger(10, [fixed('tcg', 4), pooled('shopify')]);
    expect(listed(l)).toEqual({ tcg: 4, shopify: 6 });

    const { next, changes } = applySale(l, 'tcg', 1);

    expect(computePool(l)).toBe(6);
    expect(computePool(next)).toBe(6);
    expect(listed(next)).toEqual({ tcg: 3, shopify: 6 });
    expect(changes.map((c) => c.allocationId)).toEqual(['tcg']);
  });

  /**
   * The one exception. If the partition is already empty it cannot absorb its
   * share of the decrement, so on-hand falls alone and the pool really does
   * shrink — taking every pooled channel with it.
   */
  it('does shrink the pool when an empty partition is oversold', () => {
    const l = ledger(10, [fixed('tcg', 0), pooled('shopify')]);
    expect(listed(l)).toEqual({ tcg: 0, shopify: 10 });

    const { next, changes, conflicts } = applySale(l, 'tcg', 2);

    expect(next.quantityOnHand).toBe(8);
    expect(listed(next)).toEqual({ tcg: 0, shopify: 8 });
    expect(changes.map((c) => c.allocationId)).toEqual(['shopify']);
    expect(conflicts.map((c) => c.code)).toContain('oversell_partition');
  });

  it('leaves other fixed partitions alone', () => {
    const l = ledger(10, [fixed('a', 5), fixed('b', 5)]);
    const { next } = applySale(l, 'a', 5);

    expect(next.allocations.find((a) => a.id === 'b')?.quantityAllocated).toBe(5);
    expect(next.quantityOnHand).toBe(5);
    expect(isLedgerValid(next)).toBe(true);
  });

  it('clamps and reports when the partition is oversold', () => {
    const l = ledger(10, [fixed('shopify', 2)]);
    const { next, conflicts } = applySale(l, 'shopify', 5);

    expect(next.allocations[0]?.quantityAllocated).toBe(0);
    expect(next.quantityOnHand).toBe(5);
    const partition = conflicts.find((c) => c.code === 'oversell_partition');
    expect(partition?.shortfall).toBe(3);
    expect(partition?.message).toMatch(/partition held 2/);
  });
});

describe('applySale on a pooled channel', () => {
  it('decrements on-hand and fans out to every pooled channel', () => {
    const l = ledger(10, [pooled('shopify'), pooled('tcg')]);
    const { next, changes } = applySale(l, 'shopify', 1);

    expect(next.quantityOnHand).toBe(9);
    expect(listed(next)).toEqual({ shopify: 9, tcg: 9 });
    // Both mirrored channels moved, including the one that did not sell.
    expect(changes.map((c) => c.allocationId).sort()).toEqual(['shopify', 'tcg']);
  });

  it('does not move a capped channel still above the pool', () => {
    const l = ledger(10, [pooled('capped', 3), pooled('open')]);
    const { changes } = applySale(l, 'open', 1);

    expect(changes.map((c) => c.allocationId)).toEqual(['open']);
  });

  it('never touches a fixed partition on the same SKU', () => {
    const l = ledger(10, [fixed('tcg', 4), pooled('shopify')]);
    const { next } = applySale(l, 'shopify', 2);

    expect(next.allocations.find((a) => a.id === 'tcg')?.quantityAllocated).toBe(4);
    expect(next.quantityOnHand).toBe(8);
  });
});

describe('applySale conflict handling', () => {
  it('clamps on-hand at zero and reports the oversell', () => {
    const l = ledger(2, [pooled('shopify')]);
    const { next, conflicts } = applySale(l, 'shopify', 5);

    expect(next.quantityOnHand).toBe(0);
    const oversell = conflicts.find((c) => c.code === 'oversell_on_hand');
    expect(oversell?.shortfall).toBe(3);
  });

  /**
   * The case TECHNICAL_DESIGN.md does not cover: a pooled sale drops on-hand
   * below Σ(fixed) + reserve while every individual number stays >= 0.
   */
  it('consumes the reserve first when a pooled sale breaks the invariant', () => {
    // 10 on hand, 6 committed to TCGPlayer, 2 reserved -> pool of 2.
    const l = ledger(10, [fixed('tcg', 6), pooled('shopify')], 2);
    expect(listed(l)).toEqual({ tcg: 6, shopify: 2 });

    // Three pooled sales, one more than the pool held.
    const { next, conflicts } = applySale(l, 'shopify', 3);

    expect(next.quantityOnHand).toBe(7);
    expect(next.reserveQuantity).toBe(1); // absorbed the shortfall
    expect(next.allocations.find((a) => a.id === 'tcg')?.quantityAllocated).toBe(6);
    expect(conflicts.map((c) => c.code)).toContain('reserve_reduced');
    expect(isLedgerValid(next)).toBe(true);
  });

  it('trims the largest fixed partition once the reserve is exhausted', () => {
    const l = ledger(10, [fixed('tcg', 6), fixed('ebay', 2), pooled('shopify')]);
    // pool = 10 - 8 = 2
    const { next, conflicts } = applySale(l, 'shopify', 4);

    expect(next.quantityOnHand).toBe(6);
    // Two units had to be reclaimed; the larger partition gave them up.
    expect(next.allocations.find((a) => a.id === 'tcg')?.quantityAllocated).toBe(4);
    expect(next.allocations.find((a) => a.id === 'ebay')?.quantityAllocated).toBe(2);
    expect(conflicts.map((c) => c.code)).toContain('partition_reduced');
    expect(isLedgerValid(next)).toBe(true);
  });

  it('always leaves a valid ledger, even when everything oversells at once', () => {
    const l = ledger(3, [fixed('tcg', 2), pooled('shopify')], 1);
    const { next, conflicts } = applySale(l, 'shopify', 99);

    expect(next.quantityOnHand).toBe(0);
    expect(isLedgerValid(next)).toBe(true);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it('reports a listed-quantity change with both endpoints, for the push payload', () => {
    const l = ledger(10, [pooled('shopify')]);
    const { changes } = applySale(l, 'shopify', 4);

    expect(changes).toEqual([
      { allocationId: 'shopify', channelInstanceId: 'chan-shopify', from: 10, to: 6 },
    ]);
  });

  it('does not mutate the ledger it was given', () => {
    const l = ledger(10, [fixed('tcg', 6)]);
    const snapshot = structuredClone(l);

    applySale(l, 'tcg', 3);

    expect(l).toEqual(snapshot);
  });

  it('rejects nonsensical sale quantities', () => {
    const l = ledger(10, [pooled('a')]);
    expect(() => applySale(l, 'a', 0)).toThrow(RangeError);
    expect(() => applySale(l, 'a', -1)).toThrow(RangeError);
    expect(() => applySale(l, 'a', 1.5)).toThrow(RangeError);
    expect(() => applySale(l, 'nope', 1)).toThrow(/No allocation/);
  });
});
