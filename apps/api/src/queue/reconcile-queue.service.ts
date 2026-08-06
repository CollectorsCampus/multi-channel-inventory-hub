import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from './redis.provider';
import { RECONCILE_QUEUE, RECONCILE_SWEEP_JOB, type ReconcileJob } from './outbound-queue.service';

/**
 * The reconciliation schedule (§6: "scheduled, default nightly + on-demand").
 *
 * BullMQ's job schedulers rather than a scheduler dependency: the queue is
 * already here, and putting the schedule in Redis means several API replicas
 * produce one sweep between them instead of one each. A node-local timer would
 * fire on every replica and hammer the platform N times a night.
 *
 * The on-demand path in the UI does **not** come through here — an operator
 * pressing "reconcile now" gets the report back in the response, not a job id.
 * This queue exists for the unattended run.
 *
 * **BullMQ 6 migration note.** v6 removed the legacy repeatable-jobs API
 * (`getRepeatableJobs`, `removeRepeatableByKey`, and the `repeat` option on
 * `add`) in favour of job schedulers. A repeatable registered by a v5 build
 * (0.4.0 and earlier) lives under different Redis keys that v6 cannot see or
 * remove — so on the first boot after the upgrade the old sweep's pending
 * delayed job may fire **once** more, then fail to reschedule itself (the
 * worker logs one "failed" warning) and is gone. The sweep is idempotent —
 * it reads drift and, only where auto-correct is on, re-queues a quantity — so
 * one extra run is harmless. To avoid even that, delete the old repeatable in
 * Redis before deploying: `DEL` the `bull:reconcile:repeat:*` keys, or run the
 * v5→v6 migration while still on v5.
 */
@Injectable()
export class ReconcileQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ReconcileQueue.name);
  private readonly queue: Queue<ReconcileJob>;

  constructor(
    @Inject(REDIS_CONNECTION) connection: Redis,
    private readonly config: ConfigService,
  ) {
    this.queue = new Queue<ReconcileJob>(RECONCILE_QUEUE, {
      connection,
      defaultJobOptions: {
        // Two attempts, widely spaced. A sweep that fails is retried once in
        // case the platform was briefly unavailable; beyond that the right
        // answer is to leave it for tomorrow rather than keep pulling on a
        // channel that is not answering.
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }

  /**
   * Install (or move) the nightly sweep.
   *
   * Called at boot. `upsertJobScheduler` is keyed by a fixed scheduler id, so a
   * changed `RECONCILE_CRON` updates the one schedule in place rather than
   * accumulating a second one beside it — which is what the old remove-then-add
   * dance existed to prevent, and which the upsert now gives for free. The
   * template carries empty `data`, because the worker tells a sweep from a
   * per-channel run by the absence of `channelInstanceId`.
   */
  async scheduleSweep(): Promise<string> {
    const pattern = this.config.get<string>('RECONCILE_CRON', '0 3 * * *');

    await this.queue.upsertJobScheduler(
      RECONCILE_SWEEP_JOB,
      { pattern },
      { name: RECONCILE_SWEEP_JOB, data: {} },
    );

    this.logger.log(`Reconciliation scheduled: ${pattern}`);
    return pattern;
  }

  /** Queue an unattended run for one channel, outside the schedule. */
  async enqueueChannel(channelInstanceId: string): Promise<void> {
    await this.queue.add('channel', { channelInstanceId });
  }

  async counts() {
    return this.queue.getJobCounts();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
