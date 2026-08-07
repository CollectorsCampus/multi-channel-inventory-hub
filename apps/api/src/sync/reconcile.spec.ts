import { describe, expect, it } from 'vitest';
import {
  correctableDrifts,
  diffLiveState,
  summarize,
  type ObservedListing,
  type ReconcilableAllocation,
} from './reconcile';

/**
 * Drift detection, exercised without a database.
 *
 * The interesting assertions here are the negative ones. Reconciliation is the
 * safety net the whole design leans on, and a net that cries wolf gets ignored
 * — so what this refuses to call drift matters at least as much as what it
 * catches.
 */

const allocation = (overrides: Partial<ReconcilableAllocation> = {}): ReconcilableAllocation => ({
  id: 'alloc-1',
  externalListingId: 'listing-1',
  listedQuantity: 5,
  desiredListedQuantity: 5,
  price: 1000,
  currency: 'USD',
  status: 'listed',
  ...overrides,
});

const observed = (overrides: Partial<ObservedListing> = {}): ObservedListing => ({
  externalListingId: 'listing-1',
  quantity: 5,
  price: 1000,
  currency: 'USD',
  active: true,
  ...overrides,
});

describe('diffLiveState', () => {
  it('reports nothing when the channel agrees with us', () => {
    const report = diffLiveState([allocation()], [observed()]);
    expect(report.drifts).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('reports a quantity difference with both values', () => {
    const report = diffLiveState([allocation({ listedQuantity: 5 })], [observed({ quantity: 2 })]);

    expect(report.drifts).toHaveLength(1);
    expect(report.drifts[0]).toMatchObject({ kind: 'quantity', ours: 5, theirs: 2 });
    expect(report.drifts[0]!.detail).toMatch(/shows 2.*pushed 5/);
  });

  /**
   * The comparison is against what we last *pushed*, not what the ledger now
   * wants. A push still in flight is normal; flagging it would bury the real
   * findings under routine noise.
   */
  it('does not call an in-flight push drift', () => {
    const report = diffLiveState(
      [allocation({ listedQuantity: 5, desiredListedQuantity: 9 })],
      [observed({ quantity: 5 })],
    );

    expect(report.drifts).toEqual([]);
    expect(report.pending).toEqual([
      {
        allocationId: 'alloc-1',
        externalListingId: 'listing-1',
        listedQuantity: 5,
        desiredListedQuantity: 9,
      },
    ]);
  });

  /**
   * The report has to name what a listing is. A platform id like a Shopify
   * `gid://…` identifies the row but tells an operator nothing, so the
   * product's name, set and condition ride along onto every finding.
   */
  it('carries the product identity and item id onto drifts and pending pushes', () => {
    const identified = allocation({
      inventoryItemId: 'item-42',
      listedQuantity: 5,
      desiredListedQuantity: 9,
      name: 'Chaos Rising Booster Box',
      setName: 'ME04: Chaos Rising',
      condition: 'SEALED',
    });

    const report = diffLiveState([identified], [observed({ quantity: 2 })]);

    expect(report.drifts[0]).toMatchObject({
      kind: 'quantity',
      inventoryItemId: 'item-42',
      name: 'Chaos Rising Booster Box',
      setName: 'ME04: Chaos Rising',
      condition: 'SEALED',
    });
    expect(report.pending[0]).toMatchObject({
      inventoryItemId: 'item-42',
      name: 'Chaos Rising Booster Box',
    });
  });

  it('omits identity and item-id fields entirely when an allocation carries none', () => {
    // An allocation with no name must add no keys — callers and the audit log
    // depend on findings staying byte-identical when there is nothing to name.
    const report = diffLiveState([allocation({ listedQuantity: 5 })], [observed({ quantity: 2 })]);
    expect('name' in report.drifts[0]!).toBe(false);
    expect('setName' in report.drifts[0]!).toBe(false);
    expect('inventoryItemId' in report.drifts[0]!).toBe(false);
  });

  it('separates a push that never landed from a channel that disagrees', () => {
    // Both at once: the ledger wants 9, we last pushed 5, the channel shows 2.
    const report = diffLiveState(
      [allocation({ listedQuantity: 5, desiredListedQuantity: 9 })],
      [observed({ quantity: 2 })],
    );

    expect(report.drifts.map((d) => d.kind)).toEqual(['quantity']);
    expect(report.pending).toHaveLength(1);
  });

  /**
   * A listing priced but not stocked is a normal resting state — 563 of 1333
   * rows in a real export. Reading it as drift would make every reconcile run
   * a wall of findings.
   */
  it('does not call agreed-upon zero stock drift', () => {
    const report = diffLiveState([allocation({ listedQuantity: 0 })], [observed({ quantity: 0 })]);
    expect(report.drifts).toEqual([]);
  });

  /**
   * Connectors must omit ids they cannot find rather than fabricating a zero,
   * so an omission is "no answer" and gets its own quieter finding.
   */
  it('reports an unreported listing as missing, not as quantity zero', () => {
    const report = diffLiveState([allocation({ listedQuantity: 5 })], []);

    expect(report.drifts).toHaveLength(1);
    expect(report.drifts[0]).toMatchObject({ kind: 'missing', ours: null, theirs: null });
  });

  it('reports a listing the channel says is inactive while we believe it is live', () => {
    const report = diffLiveState([allocation()], [observed({ active: false })]);
    expect(report.drifts.map((d) => d.kind)).toEqual(['inactive']);
  });

  it('does not call an inactive listing drift when we already delisted it', () => {
    // Agreement, not disagreement.
    const report = diffLiveState(
      [allocation({ status: 'delisted', listedQuantity: 0 })],
      [observed({ quantity: 0, active: false })],
    );
    expect(report.drifts).toEqual([]);
  });

  describe('prices', () => {
    it('ignores a price difference by default', () => {
      // §6's price policy is last-write-wins, and platforms round, apply fees
      // and report sale prices. A permanent stream of findings nobody can act
      // on is worse than none.
      const report = diffLiveState([allocation({ price: 1000 })], [observed({ price: 1250 })]);
      expect(report.drifts).toEqual([]);
    });

    it('reports one when asked', () => {
      const report = diffLiveState([allocation({ price: 1000 })], [observed({ price: 1250 })], {
        comparePrices: true,
      });
      expect(report.drifts[0]).toMatchObject({ kind: 'price', ours: 1000, theirs: 1250 });
      expect(report.drifts[0]!.detail).toMatch(/12\.50.*10\.00/);
    });

    it('says nothing about an allocation with no price of its own', () => {
      const report = diffLiveState([allocation({ price: null })], [observed({ price: 1250 })], {
        comparePrices: true,
      });
      expect(report.drifts).toEqual([]);
    });

    it('says nothing when the platform does not report a price', () => {
      const live: ObservedListing = { externalListingId: 'listing-1', quantity: 5, active: true };
      const report = diffLiveState([allocation()], [live], { comparePrices: true });
      expect(report.drifts).toEqual([]);
    });
  });

  it('lists channel listings we do not manage without calling them drift', () => {
    // Sellers list things outside the hub. Not a fault, but the only signal
    // that the two sides disagree about what exists.
    const report = diffLiveState(
      [allocation()],
      [observed(), observed({ externalListingId: 'listing-elsewhere' })],
    );

    expect(report.drifts).toEqual([]);
    expect(report.unmanaged).toEqual(['listing-elsewhere']);
  });

  it('handles a channel with nothing on it', () => {
    expect(diffLiveState([], [])).toEqual({
      checked: 0,
      drifts: [],
      pending: [],
      unmanaged: [],
    });
  });

  it('produces an identical report for identical input', () => {
    // The caller decides whether anything changed since the last run by
    // comparing reports, so ordering must not wander.
    const allocations = [
      allocation({ id: 'a', externalListingId: 'l-a', listedQuantity: 1 }),
      allocation({ id: 'b', externalListingId: 'l-b', listedQuantity: 2 }),
      allocation({ id: 'c', externalListingId: 'l-c', listedQuantity: 3 }),
    ];
    const live = [
      observed({ externalListingId: 'l-c', quantity: 0 }),
      observed({ externalListingId: 'l-a', quantity: 0 }),
    ];

    expect(JSON.stringify(diffLiveState(allocations, live))).toBe(
      JSON.stringify(diffLiveState(allocations, live)),
    );
    expect(diffLiveState(allocations, live).drifts.map((d) => d.allocationId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('correctableDrifts', () => {
  /**
   * §6 permits correction in exactly one direction: push our ledger to the
   * channel. Anything that would need us to act on the channel's behalf in the
   * other direction is excluded on purpose.
   */
  it('allows a quantity difference to be pushed again', () => {
    const report = diffLiveState([allocation({ listedQuantity: 5 })], [observed({ quantity: 2 })]);
    expect(correctableDrifts(report.drifts).map((d) => d.kind)).toEqual(['quantity']);
  });

  it('refuses to act on a listing the channel never reported', () => {
    // There may be nothing there to push to.
    const report = diffLiveState([allocation()], []);
    expect(correctableDrifts(report.drifts)).toEqual([]);
  });

  it('refuses to reactivate a listing the seller pulled', () => {
    const report = diffLiveState([allocation()], [observed({ active: false })]);
    expect(correctableDrifts(report.drifts)).toEqual([]);
  });

  it('refuses to overwrite a price, since last-write-wins may mean theirs', () => {
    const report = diffLiveState([allocation({ price: 1000 })], [observed({ price: 1250 })], {
      comparePrices: true,
    });
    expect(correctableDrifts(report.drifts)).toEqual([]);
  });
});

describe('summarize', () => {
  it('says so plainly when there is nothing to report', () => {
    expect(summarize(diffLiveState([allocation()], [observed()]))).toMatch(/everything matches/);
  });

  it('counts findings by kind', () => {
    const report = diffLiveState(
      [
        allocation({ id: 'a', externalListingId: 'l-a', listedQuantity: 5 }),
        allocation({ id: 'b', externalListingId: 'l-b' }),
      ],
      [observed({ externalListingId: 'l-a', quantity: 1 })],
    );

    expect(summarize(report)).toBe('Checked 2 listing(s); 2 differ (1 quantity, 1 missing).');
  });
});
