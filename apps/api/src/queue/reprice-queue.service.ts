import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from './redis.provider';
import { REPRICE_QUEUE, REPRICE_SWEEP_JOB, type RepriceJob } from './outbound-queue.service';

/**
 * The repricing schedule — market prices pulled at least daily, per the
 * operator's requirement.
 *
 * A BullMQ job scheduler for the same reasons the reconcile sweep uses one:
 * the schedule lives in Redis, so several API replicas produce one sweep
 * between them, and `upsertJobScheduler` keyed on a fixed id means a changed
 * `REPRICE_CRON` moves the one schedule instead of adding a second.
 *
 * The on-demand path does not come through here — an operator pressing
 * "sweep now" gets the report back in the response.
 */
@Injectable()
export class RepriceQueue implements OnModuleDestroy {
  private readonly logger = new Logger(RepriceQueue.name);
  private readonly queue: Queue<RepriceJob>;

  constructor(
    @Inject(REDIS_CONNECTION) connection: Redis,
    private readonly config: ConfigService,
  ) {
    this.queue = new Queue<RepriceJob>(REPRICE_QUEUE, {
      connection,
      defaultJobOptions: {
        // One retry, widely spaced: a sweep that fails twice is better left
        // for tomorrow than hammered — the prices are a day old either way.
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }

  async scheduleSweep(): Promise<string> {
    const pattern = this.config.get<string>('REPRICE_CRON', '30 3 * * *');

    await this.queue.upsertJobScheduler(
      REPRICE_SWEEP_JOB,
      { pattern },
      { name: REPRICE_SWEEP_JOB, data: {} },
    );

    this.logger.log(`Repricing sweep scheduled: ${pattern}`);
    return pattern;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
