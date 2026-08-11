import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from '../queue/redis.provider';
import { REPRICE_QUEUE, type RepriceJob } from '../queue/outbound-queue.service';
import { RepriceQueue } from '../queue/reprice-queue.service';
import { RepriceService } from './reprice.service';

/**
 * Runs the unattended repricing sweep.
 *
 * Thin, like the reconcile worker and for the same reason: all the work is in
 * RepriceService, which the on-demand endpoint calls directly, so the
 * scheduled and manual paths cannot drift apart. Concurrency 1 — two sweeps
 * at once would double the catalog sources' request rate for no gain.
 */
@Injectable()
export class RepriceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RepriceWorker.name);
  private worker?: Worker<RepriceJob>;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    private readonly config: ConfigService,
    private readonly queue: RepriceQueue,
    private readonly reprice: RepriceService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('RUN_WORKERS_IN_PROCESS')) return;

    this.worker = new Worker<RepriceJob>(REPRICE_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.warn(`Reprice job ${job?.id ?? '?'} failed: ${error.message}`);
    });

    // From the worker, not the queue provider, so a web-only replica does not
    // install the schedule; and failing to schedule must not stop the boot.
    try {
      await this.queue.scheduleSweep();
    } catch (error) {
      this.logger.error(`Could not schedule repricing: ${(error as Error).message}`);
    }

    this.logger.log(`Reprice worker listening on ${REPRICE_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(_job: Job<RepriceJob>): Promise<void> {
    await this.reprice.sweep();
  }
}
