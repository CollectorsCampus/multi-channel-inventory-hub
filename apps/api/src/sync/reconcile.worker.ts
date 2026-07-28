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
import { RECONCILE_QUEUE, type ReconcileJob } from '../queue/outbound-queue.service';
import { ReconcileQueue } from '../queue/reconcile-queue.service';
import { ReconcileService } from './reconcile.service';

/**
 * Runs the unattended reconciliation sweep (§6).
 *
 * Deliberately thin. All the work is in ReconcileService, which the on-demand
 * endpoint calls directly — so the scheduled and manual paths cannot drift
 * apart, and the sweep is exercised by the same tests.
 *
 * Concurrency is 1. A sweep talks to every channel in turn at each connector's
 * declared rate; running two at once would double that rate behind the
 * limiter's back, and there is nothing to gain by finishing a nightly job
 * sooner.
 */
@Injectable()
export class ReconcileWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileWorker.name);
  private worker?: Worker<ReconcileJob>;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    private readonly config: ConfigService,
    private readonly queue: ReconcileQueue,
    private readonly reconcile: ReconcileService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('RUN_WORKERS_IN_PROCESS')) return;

    this.worker = new Worker<ReconcileJob>(RECONCILE_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.warn(`Reconcile job ${job?.id ?? '?'} failed: ${error.message}`);
    });

    // Registering the schedule from the worker, not the queue provider, so a
    // web-only replica does not install it. Failing to schedule must not stop
    // the process booting: the on-demand path still works, and an operator
    // with no nightly sweep is far better off than one with no application.
    try {
      await this.queue.scheduleSweep();
    } catch (error) {
      this.logger.error(`Could not schedule reconciliation: ${(error as Error).message}`);
    }

    this.logger.log(`Reconcile worker listening on ${RECONCILE_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<ReconcileJob>): Promise<void> {
    const { channelInstanceId } = job.data;

    if (channelInstanceId) {
      await this.reconcile.reconcileChannel(channelInstanceId);
      return;
    }

    await this.reconcile.reconcileAll();
  }
}
