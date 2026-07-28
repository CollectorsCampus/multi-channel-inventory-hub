import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from './redis.provider';
import { RECONCILE_QUEUE, RECONCILE_SWEEP_JOB, type ReconcileJob } from './outbound-queue.service';

/**
 * The reconciliation schedule (§6: "scheduled, default nightly + on-demand").
 *
 * BullMQ's repeatable jobs rather than a scheduler dependency: the queue is
 * already here, and putting the schedule in Redis means several API replicas
 * produce one sweep between them instead of one each. A node-local timer would
 * fire on every replica and hammer the platform N times a night.
 *
 * The on-demand path in the UI does **not** come through here — an operator
 * pressing "reconcile now" gets the report back in the response, not a job id.
 * This queue exists for the unattended run.
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
   * Install (or move) the nightly repeatable.
   *
   * Called at boot. Registering under a fixed job id means a changed
   * `RECONCILE_CRON` replaces the existing schedule instead of accumulating a
   * second one beside it — stale repeatables are otherwise invisible until two
   * sweeps run on the same night.
   */
  async scheduleSweep(): Promise<string> {
    const pattern = this.config.get<string>('RECONCILE_CRON', '0 3 * * *');

    // Remove whatever was registered before, whatever its pattern. Matching on
    // the current pattern would leave an old one behind precisely when the
    // operator has just changed it.
    for (const existing of await this.queue.getRepeatableJobs()) {
      if (existing.name === RECONCILE_SWEEP_JOB) {
        await this.queue.removeRepeatableByKey(existing.key);
      }
    }

    await this.queue.add(
      RECONCILE_SWEEP_JOB,
      {},
      { repeat: { pattern }, jobId: RECONCILE_SWEEP_JOB },
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
