import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { AuthSettingsService, OIDC_CREDENTIAL_REF } from './auth-settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CredentialStore } from '../connectors/credential-store.service';

/**
 * The merge rule, which is the whole of this feature's safety argument.
 *
 * The settings screen was deliberately read-only because a form over
 * environment-owned values would either lie or imply a restart. Making OIDC
 * editable keeps that property by letting the environment win and marking those
 * fields locked — so these tests are not about storage, they are about the form
 * never being able to misrepresent what is in effect.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

let prisma: PrismaClient;

/** An in-memory stand-in for the encrypted store. */
function fakeCredentials() {
  const bundles = new Map<string, Record<string, string>>();
  return {
    store: bundles,
    service: {
      has: async (ref: string) => bundles.has(ref),
      get: async (ref: string) => bundles.get(ref) ?? {},
      put: async (ref: string, secrets: Record<string, string>) => void bundles.set(ref, secrets),
      delete: async (ref: string) => void bundles.delete(ref),
    } as unknown as CredentialStore,
  };
}

function make(env: Record<string, string | undefined> = {}) {
  const credentials = fakeCredentials();
  const service = new AuthSettingsService(
    prisma as unknown as PrismaService,
    credentials.service,
    env,
  );
  return { service, credentials };
}

describeDb('AuthSettingsService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'auth.oidc.' } } });
  });

  describe('the merge', () => {
    it('uses the stored value when the environment says nothing', async () => {
      const { service } = make();
      await service.save({ issuer: 'https://idp.example.com', clientId: 'from-db' });

      const effective = service.effective();
      expect(effective.issuer).toBe('https://idp.example.com');
      expect(effective.clientId).toBe('from-db');
      expect(service.managedByEnv('issuer')).toBe(false);
    });

    it('lets the environment win over anything stored', async () => {
      const { service } = make();
      await service.save({ issuer: 'https://stored.example.com' });

      const withEnv = make({ OIDC_ISSUER_URL: 'https://env.example.com' });
      // Same database row, different environment.
      expect(withEnv.service.effective().issuer).toBe('https://env.example.com');
      expect(withEnv.service.managedByEnv('issuer')).toBe(true);
    });

    /**
     * The distinction `ConfigService` cannot make, and the reason the raw
     * environment is read: several of these have schema defaults, so "set to
     * the default" and "not set" look identical through it. Locked has to mean
     * the operator declared it.
     */
    it('treats a blank environment variable as undeclared', () => {
      const { service } = make({ OIDC_ISSUER_URL: '' });
      expect(service.managedByEnv('issuer')).toBe(false);
    });

    it('reads AUTH_PROVIDER rather than a boolean for enabled', async () => {
      expect(make({ AUTH_PROVIDER: 'oidc' }).service.effective().enabled).toBe(true);
      expect(make({ AUTH_PROVIDER: 'local' }).service.effective().enabled).toBe(false);

      const { service } = make();
      await service.save({ enabled: true });
      expect(service.effective().enabled).toBe(true);
    });

    it('falls back to the documented defaults when nothing says otherwise', () => {
      const effective = make().service.effective();
      expect(effective.scopes).toBe('openid profile email');
      expect(effective.defaultRole).toBe('viewer');
      // Break-glass stays open unless someone closes it.
      expect(effective.allowLocalLogin).toBe(true);
      expect(effective.enabled).toBe(false);
    });
  });

  describe('writing', () => {
    /**
     * Refused rather than dropped. Silently ignoring a locked field would let
     * the screen report a save that changed nothing — the "form that lies" the
     * read-only design existed to prevent, arriving by a different route.
     */
    it('refuses a field the environment owns, naming the variable', async () => {
      const { service } = make({ OIDC_ISSUER_URL: 'https://env.example.com' });

      await expect(service.save({ issuer: 'https://other.example.com' })).rejects.toThrow(
        /OIDC_ISSUER_URL/,
      );
      expect(service.effective().issuer).toBe('https://env.example.com');
    });

    it('still writes the fields the environment leaves alone', async () => {
      const { service } = make({ OIDC_ISSUER_URL: 'https://env.example.com' });
      await service.save({ clientId: 'editable' });

      expect(service.effective().clientId).toBe('editable');
    });

    it('puts the client secret in the encrypted store, not in settings', async () => {
      const { service, credentials } = make();
      await service.save({ clientSecret: 'shh' });

      expect(credentials.store.get(OIDC_CREDENTIAL_REF)).toEqual({ clientSecret: 'shh' });
      const rows = await prisma.setting.findMany({ where: { key: 'auth.oidc.clientSecret' } });
      expect(rows).toHaveLength(0);
    });

    it('clears the secret on an explicit empty string', async () => {
      const { service, credentials } = make();
      await service.save({ clientSecret: 'shh' });
      await service.save({ clientSecret: '' });

      expect(credentials.store.has(OIDC_CREDENTIAL_REF)).toBe(false);
    });

    /** Omitted must mean "keep", or every save would wipe the secret. */
    it('leaves the secret alone when it is not in the patch', async () => {
      const { service, credentials } = make();
      await service.save({ clientSecret: 'shh' });
      await service.save({ clientId: 'unrelated' });

      expect(credentials.store.get(OIDC_CREDENTIAL_REF)).toEqual({ clientSecret: 'shh' });
    });
  });

  describe('the view the form renders', () => {
    it('never returns the secret, only whether one is set', async () => {
      const { service } = make();
      await service.save({ clientSecret: 'shh' });

      const view = service.view('https://hub.example.com/api/auth/oidc/callback');
      expect(view.clientSecretSet).toBe(true);
      expect(view.fields.clientSecret.value).toBe('');
      expect(JSON.stringify(view)).not.toContain('shh');
    });

    it('marks exactly the environment-owned fields as locked', () => {
      const { service } = make({ OIDC_CLIENT_ID: 'from-env' });
      const view = service.view('https://hub.example.com/api/auth/oidc/callback');

      expect(view.fields.clientId.managedByEnv).toBe(true);
      expect(view.fields.issuer.managedByEnv).toBe(false);
      expect(view.fields.clientId.value).toBe('from-env');
    });

    it('carries the redirect URI, so it can be copied into the provider', () => {
      const view = make().service.view('https://hub.example.com/api/auth/oidc/callback');
      expect(view.redirectUri).toBe('https://hub.example.com/api/auth/oidc/callback');
    });
  });
});
