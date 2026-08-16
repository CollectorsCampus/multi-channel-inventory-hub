import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from './redis.provider';

/**
 * Outbound push queue (TECHNICAL_DESIGN.md §6).
 *
 * One queue per **connector key**, not per channel instance. §5 declares rate
 * limits on the connector, and BullMQ's limiter is per queue, so this is what
 * makes a declared limit actually enforceable. Two Shopify stores share
 * Shopify's allowance, which is also how Shopify itself accounts for it.
 */

export type OutboundOperation = 'quantity' | 'price' | 'listing' | 'delist';

export interface OutboundJob {
  channelInstanceId: string;
  allocationId: string;
  operation: OutboundOperation;
  /** Correlates the job with the SyncEvent written when it was queued. */
  syncEventId?: string;
}

/**
 * §6 writes this as `push:{...}`, which BullMQ rejects — it uses `:` as its own
 * Redis key separator, so a colon in a queue name throws at construction.
 * A dash carries the same meaning and is legal.
 */
export const outboundQueueName = (connectorKey: string) => `push-${connectorKey}`;

/**
 * Inbound queue. One for everything, unlike outbound.
 *
 * Inbound work does not call the platform, so there is no rate limit to
 * enforce and no reason to partition by connector. Its cost is database work
 * on our own ledger.
 */
export const INBOUND_QUEUE = 'inbound';

export interface InboundJob {
  /** The persisted WebhookEvent to process. Payload is read from the row. */
  webhookEventId: string;
}

/**
 * Reconciliation queue. One repeatable job, not one per channel.
 *
 * The sweep is a single scheduled tick that then walks the channels itself.
 * Scheduling per channel would mean adding and removing repeatable jobs as
 * channels come and go, and a stale repeatable in Redis outliving the channel
 * that created it is a well-known way to end up with jobs nobody can explain.
 */
export const RECONCILE_QUEUE = 'reconcile';

/** The job scheduler's fixed id, so re-registering it replaces rather than adds. */
export const RECONCILE_SWEEP_JOB = 'nightly-sweep';

export interface ReconcileJob {
  /** Omitted by the sweep, which does every eligible channel. */
  channelInstanceId?: string;
}

/** The repricing sweep's queue — same shape as reconcile, for the same reasons. */
export const REPRICE_QUEUE = 'reprice';

/** The job scheduler's fixed id, so re-registering replaces rather than adds. */
export const REPRICE_SWEEP_JOB = 'daily-reprice';

/** Carries nothing: the sweep reads everything at run time. */
export type RepriceJob = Record<string, never>;

/** The sold-out sweep's queue — same shape again, for the same reasons. */
export const SELLOUT_QUEUE = 'sellout';

/** The job scheduler's fixed id, so re-registering replaces rather than adds. */
export const SELLOUT_SWEEP_JOB = 'daily-sellout';

/** Carries nothing: the sweep finds its own channels at run time. */
export type SelloutJob = Record<string, never>;

@Injectable()
export class OutboundQueue implements OnModuleDestroy {
  private readonly logger = new Logger(OutboundQueue.name);
  private readonly queues = new Map<string, Queue<OutboundJob>>();

  constructor(@Inject(REDIS_CONNECTION) private readonly connection: Redis) {}

  queueFor(connectorKey: string): Queue<OutboundJob> {
    let queue = this.queues.get(connectorKey);
    if (!queue) {
      queue = new Queue<OutboundJob>(outboundQueueName(connectorKey), {
        connection: this.connection,
        defaultJobOptions: {
          // Exponential backoff per §6. Five attempts spans roughly ten minutes,
          // long enough to ride out a platform blip without leaving an operator
          // staring at a stuck listing all day.
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          // Removed the instant it succeeds, and that is **load-bearing rather
          // than tidiness**. `enqueue` below reuses one job id per allocation
          // and operation so a burst collapses; BullMQ enforces that by
          // refusing `add` for an id it already holds — including one sitting
          // in the *completed* set. Retaining completed jobs therefore meant
          // the first successful quantity push for an allocation permanently
          // poisoned its id: every later change was accepted by `enqueue`,
          // logged as queued, and silently discarded, until 500 more
          // completions on that queue happened to evict it.
          //
          // The failure mode is the worst shape available — a storefront that
          // syncs once and then quietly never again, with no error, no failed
          // job and nothing in the alert inbox. Found by pushing a quantity
          // twice against the live store and watching the second vanish.
          //
          // Nothing is lost by removing them: `SyncEvent` is the durable record
          // of what was pushed and how it went, and the comment below is why
          // failures are still kept.
          removeOnComplete: true,
          // Failures are kept far longer: they are what an operator needs to
          // look at, and SyncEvent records the outcome but not the job itself.
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
      this.queues.set(connectorKey, queue);
    }
    return queue;
  }

  /**
   * Queue an outbound push.
   *
   * The job carries *what changed*, never the value. The worker re-reads the
   * desired quantity when it runs, so a retry that lands after a newer change
   * writes the current value rather than a stale one. Carrying the number here
   * would make out-of-order delivery corrupt the channel — and out-of-order
   * delivery is normal once retries and backoff exist.
   */
  async enqueue(connectorKey: string, job: OutboundJob): Promise<void> {
    const queue = this.queueFor(connectorKey);

    // Collapses a burst of edits to one allocation into a single pending job.
    // Safe precisely because the payload carries no value: whichever job
    // survives reads the latest state.
    //
    // This only collapses while a job is **pending or running**. Once it
    // finishes it is removed (see `removeOnComplete` above), which frees the id
    // for the next change — without that, an allocation would sync exactly once
    // and then never again.
    //
    // Dash-separated, not colon: BullMQ rejects `:` in custom job ids for the
    // same reason it rejects it in queue names — it is their Redis key
    // separator.
    const jobId = `${job.allocationId}-${job.operation}`;

    await queue.add(job.operation, job, { jobId });
    this.logger.debug(`Queued ${job.operation} for allocation ${job.allocationId}`);
  }

  async counts(connectorKey: string) {
    return this.queueFor(connectorKey).getJobCounts();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
