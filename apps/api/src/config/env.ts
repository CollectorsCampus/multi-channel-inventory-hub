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

  // --- Authentication (§8) --------------------------------------------------
  AUTH_PROVIDER: z.enum(['local', 'oidc']).default('local'),

  /** Base issuer URL; discovery appends /.well-known/openid-configuration. */
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),

  /**
   * Claim carrying the user's groups or roles. When set, the identity provider
   * becomes authoritative and the mapped role is reapplied on every login, so
   * revoking a group there takes effect here immediately. Leave unset to manage
   * roles locally after provisioning.
   */
  OIDC_ROLE_CLAIM: z.string().optional(),
  /** JSON object mapping claim values to roles, e.g. {"hub-admins":"admin"}. */
  OIDC_ROLE_MAP: z.string().optional(),
  OIDC_DEFAULT_ROLE: z.enum(['viewer', 'editor', 'admin']).default('viewer'),

  /**
   * Keep password login working alongside SSO.
   *
   * On by default, and deliberately so: this is self-hosted software where a
   * mistyped redirect URI or a rotated client secret would otherwise lock an
   * operator out of their own inventory with no route back in. Turn it off once
   * the SSO flow is verified.
   */
  OIDC_ALLOW_LOCAL_LOGIN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

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

  if (parsed.data.AUTH_PROVIDER === 'oidc') {
    const missing = (['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const).filter(
      (key) => !parsed.data[key],
    );

    if (missing.length > 0) {
      throw new Error(
        `AUTH_PROVIDER=oidc requires ${missing.join(', ')}. Half-configured SSO fails at the ` +
          `first login attempt rather than at boot, which is the worst moment to find out.`,
      );
    }
  }

  // Parsed at boot rather than at first login for the same reason: a typo in
  // the mapping should stop the container, not silently give everyone `viewer`.
  parseRoleMap(parsed.data.OIDC_ROLE_MAP);

  return parsed.data;
}

/**
 * Claim value → role, from the JSON in `OIDC_ROLE_MAP`.
 *
 * Exported so the provider and `validateEnv` cannot disagree about what a valid
 * mapping is.
 */
export function parseRoleMap(raw: string | undefined): Record<string, UserRole> {
  if (!raw || raw.trim() === '') return {};

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(
      'OIDC_ROLE_MAP must be a JSON object mapping claim values to roles, ' +
        'e.g. {"hub-admins":"admin","hub-staff":"editor"}.',
    );
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('OIDC_ROLE_MAP must be a JSON object, not an array or scalar.');
  }

  const map: Record<string, UserRole> = {};
  for (const [claimValue, role] of Object.entries(decoded)) {
    if (!isRole(role)) {
      throw new Error(
        `OIDC_ROLE_MAP maps "${claimValue}" to "${String(role)}", which is not a role. ` +
          `Valid roles: ${ROLES.join(', ')}.`,
      );
    }
    map[claimValue] = role;
  }

  return map;
}

/**
 * Duplicated from `@hub/db`'s USER_ROLES rather than imported.
 *
 * This module is evaluated while NestJS loads its configuration, before the
 * Prisma client is constructed; pulling the database package in here would make
 * a bad DATABASE_URL surface as a confusing import-time failure instead of the
 * clear validation error below it.
 */
const ROLES = ['viewer', 'editor', 'admin'] as const;
type UserRole = (typeof ROLES)[number];

function isRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
