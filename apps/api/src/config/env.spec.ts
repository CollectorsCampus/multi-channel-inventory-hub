import { describe, expect, it } from 'vitest';
import { parseRoleMap, validateEnv } from './env';

/**
 * Boot-time configuration.
 *
 * Untested until now, which was the wrong shape of gap: this is the one place
 * that decides whether a deployment starts, and three of its values are
 * *booleans derived from strings*. A coercion that silently stopped working
 * would not fail CI — every suite here sets its own config — it would fail on
 * someone's server, and two of the three fail towards **less** safety:
 * `OIDC_ALLOW_LOCAL_LOGIN=false` becoming truthy leaves the password door open
 * on an SSO deployment that deliberately closed it.
 *
 * So the assertions below are mostly `toBe(false)` on booleans. That is the
 * point: `Boolean('false')` is `true`, and only an identity check catches a
 * coercion that degrades into a non-empty string.
 */

const KEY = Buffer.alloc(32, 1).toString('base64');

const minimal = () => ({
  DATABASE_URL: 'postgresql://hub:hub@localhost:5432/hub',
  CREDENTIAL_MASTER_KEY: KEY,
  SESSION_SECRET: KEY,
});

describe('validateEnv', () => {
  it('accepts a minimal configuration and applies the documented defaults', () => {
    const env = validateEnv(minimal());

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_PROVIDER).toBe('postgresql');
    expect(env.AUTH_PROVIDER).toBe('local');
    expect(env.RECONCILE_CRON).toBe('0 3 * * *');
  });

  it('coerces PORT from a string, because every environment variable is one', () => {
    expect(validateEnv({ ...minimal(), PORT: '8080' }).PORT).toBe(8080);
  });

  describe('string-to-boolean flags', () => {
    // Real booleans, not truthy strings. `Boolean('false') === true`, so an
    // identity check is the only assertion that can fail here.
    it('defaults to real booleans', () => {
      const env = validateEnv(minimal());

      expect(env.RUN_WORKERS_IN_PROCESS).toBe(true);
      expect(env.OIDC_ALLOW_LOCAL_LOGIN).toBe(true);
      expect(env.ENABLE_QUERY_CONSOLE).toBe(false);
    });

    it('turns "false" into false rather than a truthy string', () => {
      const env = validateEnv({
        ...minimal(),
        RUN_WORKERS_IN_PROCESS: 'false',
        OIDC_ALLOW_LOCAL_LOGIN: 'false',
      });

      expect(env.RUN_WORKERS_IN_PROCESS).toBe(false);
      expect(env.OIDC_ALLOW_LOCAL_LOGIN).toBe(false);
    });

    it('refuses a spelling it does not recognise instead of guessing', () => {
      // "yes" and "1" are not accepted; an operator who typed one should be
      // told, not silently given the default.
      expect(() => validateEnv({ ...minimal(), RUN_WORKERS_IN_PROCESS: 'yes' })).toThrow(
        /RUN_WORKERS_IN_PROCESS/,
      );
    });
  });

  describe('required values', () => {
    it('refuses a master key that is not 32 bytes', () => {
      expect(() =>
        validateEnv({ ...minimal(), CREDENTIAL_MASTER_KEY: Buffer.alloc(16).toString('base64') }),
      ).toThrow(/CREDENTIAL_MASTER_KEY must be 32 base64-encoded bytes/);
    });

    it('refuses a missing database url', () => {
      const { DATABASE_URL: _omitted, ...rest } = minimal();
      expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
    });

    it('names every invalid key at once rather than one per restart', () => {
      // A container that reports one problem per boot is a container someone
      // restarts five times.
      const message = (() => {
        try {
          validateEnv({ ...minimal(), PORT: 'nope', LOG_LEVEL: 'chatty' });
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      })();

      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/LOG_LEVEL/);
    });
  });

  describe('cross-field rules', () => {
    it('refuses the query console without its own database url', () => {
      // The shortcut this blocks — pointing it at DATABASE_URL — removes the
      // whole protection silently.
      expect(() => validateEnv({ ...minimal(), ENABLE_QUERY_CONSOLE: 'true' })).toThrow(
        /QUERY_CONSOLE_DATABASE_URL/,
      );
    });

    it('accepts the query console with one', () => {
      const env = validateEnv({
        ...minimal(),
        ENABLE_QUERY_CONSOLE: 'true',
        QUERY_CONSOLE_DATABASE_URL: 'postgresql://readonly@localhost:5432/hub',
      });

      expect(env.ENABLE_QUERY_CONSOLE).toBe(true);
    });

    it('refuses half-configured SSO at boot, not at the first login', () => {
      expect(() => validateEnv({ ...minimal(), AUTH_PROVIDER: 'oidc' })).toThrow(
        /OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET/,
      );
    });

    it('accepts fully configured SSO', () => {
      const env = validateEnv({
        ...minimal(),
        AUTH_PROVIDER: 'oidc',
        OIDC_ISSUER_URL: 'https://idp.example.com',
        OIDC_CLIENT_ID: 'hub',
        OIDC_CLIENT_SECRET: 'secret',
      });

      expect(env.AUTH_PROVIDER).toBe('oidc');
      expect(env.OIDC_SCOPES).toBe('openid profile email');
      expect(env.OIDC_DEFAULT_ROLE).toBe('viewer');
    });

    it('rejects a role map typo at boot rather than granting viewer to everyone', () => {
      expect(() => validateEnv({ ...minimal(), OIDC_ROLE_MAP: '{"admins":"superuser"}' })).toThrow(
        /not a role/,
      );
    });
  });

  it('validates APP_URL as a url', () => {
    expect(() => validateEnv({ ...minimal(), APP_URL: 'not-a-url' })).toThrow(/APP_URL/);
    expect(validateEnv({ ...minimal(), APP_URL: 'https://hub.example.com' }).APP_URL).toBe(
      'https://hub.example.com',
    );
  });
});

describe('parseRoleMap', () => {
  it('treats absent and empty as no mapping', () => {
    expect(parseRoleMap(undefined)).toEqual({});
    expect(parseRoleMap('  ')).toEqual({});
  });

  it('maps claim values to roles', () => {
    expect(parseRoleMap('{"hub-admins":"admin","hub-staff":"editor"}')).toEqual({
      'hub-admins': 'admin',
      'hub-staff': 'editor',
    });
  });

  it('refuses anything that is not a JSON object', () => {
    expect(() => parseRoleMap('not json')).toThrow(/must be a JSON object/);
    expect(() => parseRoleMap('["admin"]')).toThrow(/not an array or scalar/);
    expect(() => parseRoleMap('"admin"')).toThrow(/not an array or scalar/);
  });

  it('names the offending claim when a value is not a role', () => {
    expect(() => parseRoleMap('{"admins":"root"}')).toThrow(/"admins" to "root"/);
  });
});
