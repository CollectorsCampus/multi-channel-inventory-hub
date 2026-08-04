import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { SettingsService } from './settings.service';
import { AuthSettingsService } from './auth-settings.service';
import { OidcService } from '../auth/oidc/oidc.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CredentialStore } from '../connectors/credential-store.service';

/**
 * The guards, and one regression that only a real request exposed.
 *
 * Everything here is about the two ways this endpoint could hurt someone:
 * enabling SSO into a state where the failure lands on a login page, and
 * closing the password door before SSO has been shown to work.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

const ISSUER = 'https://idp.example.com';

let prisma: PrismaClient;

const noCredentials = {
  has: async () => false,
  get: async () => ({}),
  put: async () => undefined,
  delete: async () => undefined,
} as unknown as CredentialStore;

function make(env: Record<string, string | undefined> = {}) {
  const settings = new AuthSettingsService(prisma as unknown as PrismaService, noCredentials, env);

  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'APP_URL' ? 'https://hub.example.com' : fallback,
    getOrThrow: (key: string) => {
      if (key === 'APP_URL') return 'https://hub.example.com';
      throw new Error(`missing ${key}`);
    },
  } as never;

  const oidc = new OidcService(config, prisma as unknown as PrismaService, settings, async () => {
    throw new Error('the network should not be reached by these tests');
  });

  return {
    service: new SettingsService(prisma as unknown as PrismaService, settings, oidc),
    settings,
  };
}

/** A body as `class-transformer` builds it: every declared key present. */
function asDto(sent: Record<string, unknown>) {
  const shape: Record<string, unknown> = {
    enabled: undefined,
    issuer: undefined,
    clientId: undefined,
    clientSecret: undefined,
    scopes: undefined,
    roleClaim: undefined,
    roleMap: undefined,
    defaultRole: undefined,
    allowLocalLogin: undefined,
    allowedEndpointOrigins: undefined,
  };
  return { ...shape, ...sent };
}

describeDb('SettingsService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'auth.oidc.' } } });
    await prisma.session.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.user.deleteMany();
  });

  /**
   * The 500 this method exists to never produce. `class-transformer`
   * materialises every declared property, so a body naming one field arrives
   * with the other nine set to `undefined`; spreading that over the effective
   * settings wiped them, and the next `.trim()` threw.
   */
  it('ignores keys the caller did not actually send', async () => {
    const { service, settings } = make();
    await settings.save({ issuer: ISSUER, clientId: 'kept' });

    await expect(service.update(asDto({ scopes: 'openid email' }))).resolves.toBeDefined();
    expect(settings.effective().clientId).toBe('kept');
    expect(settings.effective().issuer).toBe(ISSUER);
  });

  it('answers with a reason rather than crashing on an incomplete enable', async () => {
    const { service } = make();

    await expect(service.update(asDto({ enabled: true }))).rejects.toThrow(
      /issuer URL and a client id/,
    );
  });

  it('refuses to enable without a client secret', async () => {
    const { service, settings } = make();
    await settings.save({ issuer: ISSUER, clientId: 'abc' });

    await expect(service.update(asDto({ enabled: true }))).rejects.toThrow(/client secret/);
  });

  it('refuses a malformed role map before it can silently do nothing', async () => {
    const { service } = make();

    await expect(service.update(asDto({ roleMap: '{not json' }))).rejects.toThrow(/Role map/);
  });

  /**
   * The lock-out rule, and the same shape the user module uses: the caller is
   * authorised, the outcome is refused, and there is no undo but a database
   * edit.
   */
  it('will not close the password door until SSO has let someone in', async () => {
    const { service } = make();

    await expect(service.update(asDto({ allowLocalLogin: false }))).rejects.toThrow(
      /No SSO user has signed in yet/,
    );

    await prisma.user.create({
      data: {
        username: 'sso-person',
        provider: 'oidc',
        externalId: 'sub-1',
        role: 'admin',
        isActive: true,
        lastLoginAt: new Date(),
      },
    });

    await expect(service.update(asDto({ allowLocalLogin: false }))).resolves.toBeDefined();
  });

  it('will not accept a field the environment owns', async () => {
    const { service } = make({ OIDC_ISSUER_URL: ISSUER });

    await expect(service.update(asDto({ issuer: 'https://other.example.com' }))).rejects.toThrow(
      /OIDC_ISSUER_URL/,
    );
  });
});
