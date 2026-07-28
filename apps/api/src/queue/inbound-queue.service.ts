import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from './redis.provider';
import { INBOUND_QUEUE, type InboundJob } from './outbound-queue.service';

/**
 * Queue for inbound platform events (§6).
 *
 * Ingress writes the raw event and enqueues its id — nothing more. The payload
 * lives in the WebhookEvent row rather than in the job, so a job that outlives
 * Redis eviction can still be reconstructed, and the raw bytes stay available
 * for signature re-verification and debugging.
 */
@Injectable()
export class InboundQueue implements OnModuleDestroy {
  private readonly logger = new Logger(InboundQueue.name);
  private readonly queue: Queue<InboundJob>;

  constructor(@Inject(REDIS_CONNECTION) connection: Redis) {
    this.queue = new Queue<InboundJob>(INBOUND_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  /**
   * Queue a persisted webhook for processing.
   *
   * The job id is the WebhookEvent id, so a duplicate enqueue of the same
   * delivery is collapsed by BullMQ rather than processed twice.
   */
  async enqueue(webhookEventId: string): Promise<void> {
    await this.queue.add('webhook', { webhookEventId }, { jobId: webhookEventId });
    this.logger.debug(`Queued inbound webhook ${webhookEventId}`);
  }

  async counts() {
    return this.queue.getJobCounts();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
