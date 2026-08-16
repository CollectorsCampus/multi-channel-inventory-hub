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
   * Extra origins this issuer's endpoints may live on, comma separated.
   *
   * Endpoints are pinned to the issuer's own origin by default, because the
   * token endpoint receives the client secret. Google needs this — its issuer
   * is `accounts.google.com` while its token endpoint is on
   * `oauth2.googleapis.com` and its JWKS on `www.googleapis.com` — and most
   * other providers do not. Naming them here is the operator saying they accept
   * that delegation, which keeps the decision theirs rather than the discovery
   * document's.
   */
  OIDC_ALLOWED_ENDPOINT_ORIGINS: z.string().optional(),

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
  REPRICE_CRON: z.string().default('30 3 * * *'),
  // Last of the three, deliberately: reconciliation may correct a quantity the
  // hub had wrong, and a card the ledger only now believes is at zero should be
  // drafted the same night rather than the next one.
  SELLOUT_CRON: z.string().default('0 4 * * *'),

  /** Directory holding the built SPA. Resolved relative to the API's dist/ at runtime. */
  WEB_ROOT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * The variables the operator actually declared, captured before defaults exist.
 *
 * **`process.env` cannot answer this, and that is not obvious.** NestJS's
 * `ConfigModule` assigns the *validated* configuration — schema defaults
 * included — back onto `process.env` once `validateEnv` returns. So by the time
 * any provider looks, `AUTH_PROVIDER` reads `local` and `OIDC_SCOPES` reads
 * `openid profile email` on an instance whose operator set neither.
 *
 * That matters wherever "did someone declare this" is a different question from
 * "what is its value" — which is exactly what the settings screen needs, to
 * decide whether a field is owned by the environment and must be shown locked.
 * Without this, every field carrying a schema default looked locked on a
 * deployment that had declared nothing, and the SSO form was almost entirely
 * read-only for no reason. Found by looking at the rendered page.
 */
let declared: Record<string, string> = {};

/** A copy, so a caller cannot mutate what the rest of the app reads. */
export function declaredEnv(): Record<string, string> {
  return { ...declared };
}

export function validateEnv(raw: Record<string, unknown>): Env {
  declared = Object.fromEntries(
    Object.entries(raw)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );

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
  parseAllowedOrigins(parsed.data.OIDC_ALLOWED_ENDPOINT_ORIGINS);

  return parsed.data;
}

/**
 * Origins from `OIDC_ALLOWED_ENDPOINT_ORIGINS`, validated at boot.
 *
 * Each must be a bare origin and each must be HTTPS, because the whole point of
 * the list is to nominate somewhere a **client secret** may be sent. A typo
 * that widened it to plain HTTP would be the one mistake this setting could
 * make catastrophic, so it stops the container instead.
 *
 * Loopback is exempt, the same exemption discovery already makes, so a
 * developer can point at an IdP running without a certificate.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(
          `OIDC_ALLOWED_ENDPOINT_ORIGINS contains "${entry}", which is not a URL. Use bare ` +
            `origins, e.g. https://oauth2.googleapis.com.`,
        );
      }

      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !loopback) {
        throw new Error(
          `OIDC_ALLOWED_ENDPOINT_ORIGINS contains "${entry}", which is not HTTPS. This list ` +
            `names hosts allowed to receive this client's secret.`,
        );
      }

      if (url.origin === 'null') {
        throw new Error(`OIDC_ALLOWED_ENDPOINT_ORIGINS contains "${entry}", which has no origin.`);
      }

      return url.origin;
    });
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
