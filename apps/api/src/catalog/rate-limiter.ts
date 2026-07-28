/**
 * Minimum-interval limiter, applied per key.
 *
 * Lives in the core on purpose. The SDK tells source and connector authors to
 * *declare* a rate limit and not implement throttling themselves, so that
 * enforcement behaves identically for every plugin and cannot be forgotten by
 * one of them. This is the enforcement.
 *
 * Deliberately simple: serialise calls per key and space them out. Public
 * catalog APIs are shared community resources — Scryfall asks for roughly
 * 10 requests/second — and being a well-behaved client matters more than
 * squeezing out maximum throughput. When BullMQ arrives in Phase 3 its own
 * limiter covers queued outbound work; this covers the synchronous request
 * path, which is not queued.
 */
export class MinIntervalLimiter {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Run `task`, ensuring at least `minIntervalMs` separates consecutive starts
   * for the same key. Calls queue behind one another rather than being dropped.
   */
  run<T>(key: string, minIntervalMs: number, task: () => Promise<T>): Promise<T> {
    if (minIntervalMs <= 0) return task();

    const previous = this.chains.get(key) ?? Promise.resolve();

    const next = previous.then(async () => {
      const last = this.lastStart.get(key);
      if (last !== undefined) {
        const wait = minIntervalMs - (this.now() - last);
        if (wait > 0) await sleep(wait);
      }
      this.lastStart.set(key, this.now());
      return task();
    });

    // Keep the chain alive regardless of outcome: one failing call must not
    // wedge every later call for that key.
    this.chains.set(
      key,
      next.catch(() => undefined),
    );

    return next;
  }
}

/** Requests per second to the minimum gap between starts. */
export function intervalFor(rateLimit?: { requestsPerSecond: number }): number {
  if (!rateLimit || rateLimit.requestsPerSecond <= 0) return 0;
  return Math.ceil(1000 / rateLimit.requestsPerSecond);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
