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
import { SELLOUT_QUEUE, type SelloutJob } from '../queue/outbound-queue.service';
import { SelloutQueue } from '../queue/sellout-queue.service';
import { SelloutService } from './sellout.service';

/**
 * Runs the unattended sold-out sweep.
 *
 * Thin, like the reconcile and reprice workers and for the same reason: the
 * work is in SelloutService, which the on-demand endpoint calls directly, so
 * the scheduled and manual paths cannot drift apart. Concurrency 1 — two
 * sweeps at once would double the connectors' request rate for no gain.
 */
@Injectable()
export class SelloutWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SelloutWorker.name);
  private worker?: Worker<SelloutJob>;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    private readonly config: ConfigService,
    private readonly queue: SelloutQueue,
    private readonly sellout: SelloutService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('RUN_WORKERS_IN_PROCESS')) return;

    this.worker = new Worker<SelloutJob>(SELLOUT_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.warn(`Sellout job ${job?.id ?? '?'} failed: ${error.message}`);
    });

    // From the worker, not the queue provider, so a web-only replica does not
    // install the schedule; and failing to schedule must not stop the boot.
    try {
      await this.queue.scheduleSweep();
    } catch (error) {
      this.logger.error(`Could not schedule the sold-out sweep: ${(error as Error).message}`);
    }

    this.logger.log(`Sellout worker listening on ${SELLOUT_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(_job: Job<SelloutJob>): Promise<void> {
    await this.sellout.sweep();
  }
}
