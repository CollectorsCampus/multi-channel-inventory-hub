import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from './redis.provider';
import { SELLOUT_QUEUE, SELLOUT_SWEEP_JOB, type SelloutJob } from './outbound-queue.service';

/**
 * The sold-out sweep's schedule.
 *
 * A BullMQ job scheduler for the same reasons the reconcile and reprice sweeps
 * use one: the schedule lives in Redis, so several API replicas produce one
 * sweep between them, and `upsertJobScheduler` keyed on a fixed id means a
 * changed `SELLOUT_CRON` moves the one schedule instead of adding a second.
 *
 * It runs after both of them by default. Reconciliation may correct a quantity
 * the hub had wrong, and a card the ledger only now believes is at zero should
 * be drafted on the same night rather than the next one.
 *
 * The on-demand path does not come through here — an operator pressing "draft
 * sold-out now" gets the report back in the response.
 */
@Injectable()
export class SelloutQueue implements OnModuleDestroy {
  private readonly logger = new Logger(SelloutQueue.name);
  private readonly queue: Queue<SelloutJob>;

  constructor(
    @Inject(REDIS_CONNECTION) connection: Redis,
    private readonly config: ConfigService,
  ) {
    this.queue = new Queue<SelloutJob>(SELLOUT_QUEUE, {
      connection,
      defaultJobOptions: {
        // One retry, widely spaced, as repricing does it: a sweep that fails
        // twice is better left for tomorrow than hammered — an unbuyable page
        // is a nuisance, not an incident.
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }

  async scheduleSweep(): Promise<string> {
    const pattern = this.config.get<string>('SELLOUT_CRON', '0 4 * * *');

    await this.queue.upsertJobScheduler(
      SELLOUT_SWEEP_JOB,
      { pattern },
      { name: SELLOUT_SWEEP_JOB, data: {} },
    );

    this.logger.log(`Sold-out sweep scheduled: ${pattern}`);
    return pattern;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
