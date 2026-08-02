import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env';

/**
 * `validateEnv` is a pure function, so it is tested directly rather than
 * through ConfigModule — the module evaluates it once at import time, which
 * makes per-case assertions impossible at that level.
 */

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

const validEnv = {
  DATABASE_URL: 'postgresql://hub:hub@localhost:5432/hub',
  CREDENTIAL_MASTER_KEY: key(1),
  SESSION_SECRET: key(2),
};

describe('validateEnv', () => {
  it('applies documented defaults', () => {
    const env = validateEnv({ ...validEnv });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DATABASE_PROVIDER).toBe('postgresql');
    expect(env.RUN_WORKERS_IN_PROCESS).toBe(true);
    expect(env.ENABLE_QUERY_CONSOLE).toBe(false);
  });

  it('coerces numeric and boolean strings', () => {
    const env = validateEnv({ ...validEnv, PORT: '8080', RUN_WORKERS_IN_PROCESS: 'false' });
    expect(env.PORT).toBe(8080);
    expect(env.RUN_WORKERS_IN_PROCESS).toBe(false);
  });

  it('names every missing required variable at once', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({})).toThrow(/CREDENTIAL_MASTER_KEY/);
    expect(() => validateEnv({})).toThrow(/SESSION_SECRET/);
  });

  it('rejects secrets that are not exactly 32 bytes', () => {
    expect(() => validateEnv({ ...validEnv, SESSION_SECRET: 'too-short' })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() =>
      validateEnv({ ...validEnv, CREDENTIAL_MASTER_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/CREDENTIAL_MASTER_KEY/);
  });

  it('rejects an unknown database provider', () => {
    expect(() => validateEnv({ ...validEnv, DATABASE_PROVIDER: 'oracle' })).toThrow(
      /DATABASE_PROVIDER/,
    );
  });

  // The query console must never share the application's read-write connection
  // — that is the whole point of it being opt-in (TECHNICAL_DESIGN.md §7).
  it('refuses to enable the query console without a separate read-only URL', () => {
    expect(() => validateEnv({ ...validEnv, ENABLE_QUERY_CONSOLE: 'true' })).toThrow(
      /QUERY_CONSOLE_DATABASE_URL/,
    );

    expect(() =>
      validateEnv({
        ...validEnv,
        ENABLE_QUERY_CONSOLE: 'true',
        QUERY_CONSOLE_DATABASE_URL: 'postgresql://ro:ro@localhost:5432/hub',
      }),
    ).not.toThrow();
  });

  /**
   * This list names hosts allowed to receive the client secret, so a typo that
   * widened it to plain HTTP is the one mistake it could make catastrophic. It
   * stops the container rather than the first login.
   */
  describe('OIDC_ALLOWED_ENDPOINT_ORIGINS', () => {
    it('accepts https origins, comma separated and whitespace tolerant', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          OIDC_ALLOWED_ENDPOINT_ORIGINS:
            'https://oauth2.googleapis.com, https://www.googleapis.com',
        }),
      ).not.toThrow();
    });

    it('refuses a plaintext origin', () => {
      expect(() =>
        validateEnv({ ...validEnv, OIDC_ALLOWED_ENDPOINT_ORIGINS: 'http://oauth2.example' }),
      ).toThrow(/not HTTPS/i);
    });

    it('refuses something that is not a URL', () => {
      expect(() =>
        validateEnv({ ...validEnv, OIDC_ALLOWED_ENDPOINT_ORIGINS: 'oauth2.googleapis.com' }),
      ).toThrow(/not a URL/i);
    });

    it('allows loopback without a certificate, as discovery already does', () => {
      expect(() =>
        validateEnv({ ...validEnv, OIDC_ALLOWED_ENDPOINT_ORIGINS: 'http://localhost:8080' }),
      ).not.toThrow();
    });

    it('is absent by default, so the old pinning is exactly what an operator gets', () => {
      expect(validateEnv({ ...validEnv }).OIDC_ALLOWED_ENDPOINT_ORIGINS).toBeUndefined();
    });
  });
});
