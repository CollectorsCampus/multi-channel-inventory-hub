import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION, createRedisConnection } from './redis.provider';
import { OutboundQueue } from './outbound-queue.service';

const redisProvider: Provider = {
  provide: REDIS_CONNECTION,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis =>
    createRedisConnection(config.getOrThrow<string>('REDIS_URL')),
};

/**
 * Queue plumbing only — no workers.
 *
 * Enqueuing and consuming are split so the modules that produce work do not
 * have to depend on the modules that perform it. InventoryService enqueues; the
 * workers in SyncModule consume, and they need InventoryService themselves.
 * Keeping them in one module would be a dependency cycle.
 */
@Global()
@Module({
  providers: [redisProvider, OutboundQueue],
  exports: [REDIS_CONNECTION, OutboundQueue],
})
export class QueueModule {}
