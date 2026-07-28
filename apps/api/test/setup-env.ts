/**
 * Runs before any test module is imported.
 *
 * `ConfigModule.forRoot({ validate })` is evaluated when app.module.ts is
 * loaded, not when a testing module is constructed — so configuration must
 * already be valid at import time. Setting these inside a `beforeAll` is too
 * late and fails at collection.
 */

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://hub:hub@localhost:5432/hub_test',
  DATABASE_PROVIDER: 'postgresql',
  REDIS_URL: 'redis://localhost:6379',
  // Unit and boot tests must not start BullMQ workers: they would open blocking
  // connections to a Redis that need not exist, and the suites here exercise
  // wiring rather than job execution. Queue behaviour is covered by its own
  // integration tests, which stand up Redis explicitly.
  RUN_WORKERS_IN_PROCESS: 'false',
  CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
  SESSION_SECRET: Buffer.alloc(32, 2).toString('base64'),
});
