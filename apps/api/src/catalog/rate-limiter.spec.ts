import { describe, expect, it } from 'vitest';
import { MinIntervalLimiter, intervalFor } from './rate-limiter';

describe('intervalFor', () => {
  it('converts a declared rate into a minimum gap', () => {
    expect(intervalFor({ requestsPerSecond: 10 })).toBe(100);
    expect(intervalFor({ requestsPerSecond: 4 })).toBe(250);
    // Rounds up, so the limit is never exceeded by rounding.
    expect(intervalFor({ requestsPerSecond: 3 })).toBe(334);
  });

  it('treats an absent or nonsensical limit as unthrottled', () => {
    expect(intervalFor(undefined)).toBe(0);
    expect(intervalFor({ requestsPerSecond: 0 })).toBe(0);
    expect(intervalFor({ requestsPerSecond: -1 })).toBe(0);
  });
});

describe('MinIntervalLimiter', () => {
  it('runs immediately when unthrottled', async () => {
    const limiter = new MinIntervalLimiter();
    await expect(limiter.run('k', 0, async () => 'done')).resolves.toBe('done');
  });

  /**
   * Real timers with a small interval, rather than fake ones. The limiter
   * interleaves setTimeout with promise chaining, and driving that with a
   * manually advanced clock tests the harness more than the code.
   */
  it('spaces consecutive calls for the same key', async () => {
    const interval = 25;
    const starts: number[] = [];
    const limiter = new MinIntervalLimiter();

    const task = async () => void starts.push(Date.now());

    await Promise.all([
      limiter.run('scryfall', interval, task),
      limiter.run('scryfall', interval, task),
      limiter.run('scryfall', interval, task),
    ]);

    expect(starts).toHaveLength(3);
    // Allow a small tolerance for timer granularity.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(interval - 5);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(interval - 5);
  });

  it('preserves submission order', async () => {
    const seen: number[] = [];
    const limiter = new MinIntervalLimiter();

    await Promise.all([1, 2, 3].map((n) => limiter.run('k', 5, async () => void seen.push(n))));

    expect(seen).toEqual([1, 2, 3]);
  });

  it('does not make one key wait on another', async () => {
    const limiter = new MinIntervalLimiter();
    const order: string[] = [];

    await Promise.all([
      limiter.run('a', 0, async () => void order.push('a')),
      limiter.run('b', 0, async () => void order.push('b')),
    ]);

    expect(order.sort()).toEqual(['a', 'b']);
  });

  /**
   * A failing call must not wedge every later call for that key — the chain is
   * shared, so an unhandled rejection there would stall the source forever.
   */
  it('keeps serving a key after a call fails', async () => {
    const limiter = new MinIntervalLimiter();

    await expect(
      limiter.run('k', 0, async () => {
        throw new Error('502');
      }),
    ).rejects.toThrow('502');

    await expect(limiter.run('k', 0, async () => 'recovered')).resolves.toBe('recovered');
  });
});
