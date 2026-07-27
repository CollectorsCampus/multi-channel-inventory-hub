import { z } from 'zod';

/**
 * 12-factor configuration. Every knob in .env.example is declared here and
 * validated once at boot — a misconfigured instance should fail loudly at
 * startup, not at the first request that happens to touch the bad value.
 */

const base64Key = (bytes: number, name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === bytes;
      } catch {
        return false;
      }
    }, `${name} must be ${bytes} base64-encoded bytes — generate one with: openssl rand -base64 ${bytes}`);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_PROVIDER: z.enum(['postgresql', 'mysql', 'sqlite']).default('postgresql'),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  RUN_WORKERS_IN_PROCESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  CREDENTIAL_MASTER_KEY: base64Key(32, 'CREDENTIAL_MASTER_KEY'),
  SESSION_SECRET: base64Key(32, 'SESSION_SECRET'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),

  ENABLE_QUERY_CONSOLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  QUERY_CONSOLE_DATABASE_URL: z.string().optional(),

  RECONCILE_CRON: z.string().default('0 3 * * *'),

  /** Directory holding the built SPA. Resolved relative to the API's dist/ at runtime. */
  WEB_ROOT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }

  if (parsed.data.ENABLE_QUERY_CONSOLE && !parsed.data.QUERY_CONSOLE_DATABASE_URL) {
    throw new Error(
      'ENABLE_QUERY_CONSOLE=true requires QUERY_CONSOLE_DATABASE_URL pointing at a ' +
        'read-only database role. The console must never share the application connection.',
    );
  }

  return parsed.data;
}
