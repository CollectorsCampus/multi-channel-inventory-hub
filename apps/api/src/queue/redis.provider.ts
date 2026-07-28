import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

/**
 * Shared Redis connection for BullMQ.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ, not a preference: its
 * blocking commands sit on a connection for long periods, and ioredis's default
 * retry cap would abort them and take workers down. BullMQ refuses to start
 * without it.
 */
export function createRedisConnection(url: string): Redis {
  const logger = new Logger('Redis');

  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Keep trying rather than giving up: Redis restarting under a running app
    // should mean paused work, not a dead process.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  connection.on('error', (error: Error) => {
    // Logged rather than thrown: an unhandled 'error' event would crash the
    // process on a transient blip that ioredis is about to recover from.
    logger.warn(`Redis connection error: ${error.message}`);
  });

  connection.on('ready', () => logger.log('Redis connection ready'));

  return connection;
}
