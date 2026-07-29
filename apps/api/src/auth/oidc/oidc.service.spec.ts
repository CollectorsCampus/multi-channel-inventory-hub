import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from 'jose';
import { createHash } from 'node:crypto';
import { OidcService, safeReturnTo } from './oidc.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The OIDC flow against a fake identity provider with real keys.
 *
 * Every negative test here is an attack that has worked against real
 * implementations: `alg: none`, a token signed by a key of the attacker's
 * choosing, RS256/HS256 confusion, a token minted for a different audience, one
 * replayed from a different login, and a callback that never started in this
 * browser. Verification is delegated to `jose` precisely so these hold, and
 * asserting them here is what stops someone "simplifying" that away later.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'inventory-hub';
const CLIENT_SECRET = 'client-secret';

let signingKey: KeyObject;
let publicJwk: JWK;
/** A well-formed key the issuer never published — stands in for an attacker's. */
let foreignKey: KeyObject;

let prisma: PrismaClient;

/** Everything the fake provider will say on the next call. */
interface Stub {
  discovery?: Record<string, unknown>;
  discoveryStatus?: number;
  tokenResponse?: Record<string, unknown>;
  tokenStatus?: number;
  /** Requests the service made, for asserting what it sent. */
  calls: Array<{ url: string; body?: string }>;
}

let stub: Stub;

function discoveryDocument(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    id_token_signing_alg_values_supported: ['RS256'],
    ...overrides,
  };
}

/** Stands in for the network: discovery, token exchange and JWKS. */
const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  stub.calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });

  if (url.includes('.well-known/openid-configuration')) {
    return new Response(JSON.stringify(stub.discovery ?? discoveryDocument()), {
      status: stub.discoveryStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (url.endsWith('/jwks')) {
    return new Response(
      JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256' }] }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  if (url.endsWith('/token')) {
    return new Response(JSON.stringify(stub.tokenResponse ?? {}), {
      status: stub.tokenStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response('not found', { status: 404 });
};

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    AUTH_PROVIDER: 'oidc',
    APP_URL: 'https://hub.example.com',
    OIDC_ISSUER_URL: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_SCOPES: 'openid profile email',
    OIDC_DEFAULT_ROLE: 'viewer',
    OIDC_ALLOW_LOCAL_LOGIN: true,
    ...overrides,
  };

  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
  } as never;
}

function makeService(overrides: Record<string, unknown> = {}) {
  return new OidcService(config(overrides), prisma as unknown as PrismaService, fakeFetch);
}

/** Mint an ID token the way the fake provider would. */
async function idToken(
  claims: Record<string, unknown> = {},
  options: { key?: KeyObject; alg?: string; issuer?: string; audience?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ nonce: 'test-nonce', ...claims })
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject((claims.sub as string) ?? 'subject-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(options.key ?? signingKey);
}

/** Drive a whole login, with the handshake the start step produced. */
async function login(
  service: OidcService,
  token: string,
  handshakeOverrides: Record<string, unknown> = {},
) {
  const { handshake } = await service.beginLogin('/');
  stub.tokenResponse = { id_token: token };

  return service.completeLogin(
    { code: 'auth-code', state: (handshakeOverrides.state as string) ?? handshake.state },
    { ...handshake, nonce: 'test-nonce', ...handshakeOverrides },
  );
}

describeDb('OidcService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();

    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey as KeyObject;
    publicJwk = await exportJWK(pair.publicKey);

    foreignKey = (await generateKeyPair('RS256')).privateKey as KeyObject;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    stub = { calls: [] };
    await prisma.session.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.user.deleteMany();
  });

  // -------------------------------------------------------------------------

  describe('the authorization request', () => {
    it('asks for a code with PKCE and one-time values', async () => {
      const { url, handshake } = await makeService().beginLogin('/inventory');
      const params = new URL(url).searchParams;

      expect(params.get('response_type')).toBe('code');
      expect(params.get('client_id')).toBe(CLIENT_ID);
      expect(params.get('redirect_uri')).toBe('https://hub.example.com/api/auth/oidc/callback');
      expect(params.get('code_challenge_method')).toBe('S256');
      expect(params.get('state')).toBe(handshake.state);
      expect(params.get('nonce')).toBe(handshake.nonce);
    });

    /**
     * The challenge must be the SHA-256 of the verifier the service kept. If it
     * were not, the token endpoint would reject every exchange — or, worse, the
     * `plain` method would be in use and PKCE would protect nothing.
     */
    it('sends the S256 hash of the verifier it kept', async () => {
      const { url, handshake } = await makeService().beginLogin('/');
      const challenge = new URL(url).searchParams.get('code_challenge');

      expect(challenge).toBe(createHash('sha256').update(handshake.verifier).digest('base64url'));
    });

    it('gives every login fresh values', async () => {
      const service = makeService();
      const first = await service.beginLogin('/');
      const second = await service.beginLogin('/');

      expect(first.handshake.state).not.toBe(second.handshake.state);
      expect(first.handshake.nonce).not.toBe(second.handshake.nonce);
      expect(first.handshake.verifier).not.toBe(second.handshake.verifier);
    });
  });

  // -------------------------------------------------------------------------

  describe('refuses a token it cannot trust', () => {
    it('accepts a properly signed one, so the negatives mean something', async () => {
      const { principal } = await login(makeService(), await idToken({ sub: 'happy-path' }));
      expect(principal.username).toBeTruthy();
    });

    it('rejects a token signed by a key the issuer never published', async () => {
      await expect(
        login(makeService(), await idToken({ sub: 'forged' }, { key: foreignKey })),
      ).rejects.toThrow(/cannot trust/i);
    });

    /**
     * The classic JWT failure. An unsigned token must never be accepted, however
     * well-formed its claims are.
     */
    it('rejects alg=none', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: 'unsigned',
          nonce: 'test-nonce',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString('base64url');

      await expect(login(makeService(), `${header}.${body}.`)).rejects.toThrow(/cannot trust/i);
    });

    /**
     * RS256/HS256 confusion: sign with HMAC using the *public* key as the shared
     * secret. A verifier that picks its algorithm from the token's own header
     * accepts this, because the public key is not a secret.
     */
    it('rejects a token that swaps RS256 for HS256 over the public key', async () => {
      const secret = new TextEncoder().encode(JSON.stringify(publicJwk.n));
      const now = Math.floor(Date.now() / 1000);

      const confused = await new SignJWT({ nonce: 'test-nonce' })
        .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('confused')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(secret);

      await expect(login(makeService(), confused)).rejects.toThrow(/cannot trust/i);
    });

    it('rejects a token minted for a different audience', async () => {
      await expect(
        login(makeService(), await idToken({ sub: 'other' }, { audience: 'someone-else' })),
      ).rejects.toThrow(/cannot trust/i);
    });

    it('rejects a token from a different issuer', async () => {
      await expect(
        login(makeService(), await idToken({ sub: 'other' }, { issuer: 'https://evil.example' })),
      ).rejects.toThrow(/cannot trust/i);
    });

    it('rejects an expired token', async () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const expired = await new SignJWT({ nonce: 'test-nonce' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('expired')
        .setIssuedAt(past)
        .setExpirationTime(past + 60)
        .sign(signingKey);

      await expect(login(makeService(), expired)).rejects.toThrow(/cannot trust/i);
    });

    /**
     * The nonce is the only claim `jose` cannot check for us, and it is what
     * stops a token captured from one login being replayed into another.
     */
    it('rejects a token whose nonce belongs to a different login', async () => {
      await expect(
        login(makeService(), await idToken({ nonce: 'someone-elses-nonce', sub: 'replay' })),
      ).rejects.toThrow(/cannot trust/i);
    });

    it('rejects a token carrying no nonce at all', async () => {
      const now = Math.floor(Date.now() / 1000);
      const noNonce = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('no-nonce')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(signingKey);

      await expect(login(makeService(), noNonce)).rejects.toThrow(/cannot trust/i);
    });
  });

  // -------------------------------------------------------------------------

  describe('refuses a callback that did not start here', () => {
    it('rejects a state that does not match the handshake', async () => {
      // Written without the helper on purpose: the mismatch has to be between
      // the callback's state and the browser's, and a helper that set both
      // would quietly make them agree.
      const service = makeService();
      const { handshake } = await service.beginLogin('/');
      stub.tokenResponse = { id_token: await idToken() };

      await expect(
        service.completeLogin({ code: 'auth-code', state: 'attacker-supplied' }, handshake),
      ).rejects.toThrow(/does not match/i);
    });

    it('rejects a callback carrying no state at all', async () => {
      const service = makeService();
      const { handshake } = await service.beginLogin('/');

      await expect(service.completeLogin({ code: 'auth-code' }, handshake)).rejects.toThrow(
        /does not match/i,
      );
    });

    /**
     * Login CSRF: without the handshake cookie an attacker can feed a victim's
     * browser their own authorization code and silently sign the victim in as
     * themselves.
     */
    it('rejects a callback with no handshake at all', async () => {
      await expect(makeService().completeLogin({ code: 'x', state: 'y' }, null)).rejects.toThrow(
        /no login is in progress/i,
      );
    });

    it('rejects a handshake that has expired', async () => {
      const service = makeService();
      const { handshake } = await service.beginLogin('/');

      await expect(
        service.completeLogin(
          { code: 'x', state: handshake.state },
          { ...handshake, issuedAt: Date.now() - 60 * 60 * 1000 },
        ),
      ).rejects.toThrow(/took too long/i);
    });

    it('passes the provider’s own refusal through', async () => {
      const service = makeService();
      const { handshake } = await service.beginLogin('/');

      await expect(
        service.completeLogin(
          { error: 'access_denied', errorDescription: 'User cancelled' },
          handshake,
        ),
      ).rejects.toThrow(/User cancelled/);
    });
  });

  // -------------------------------------------------------------------------

  describe('the code exchange', () => {
    it('sends the verifier, so an intercepted code alone is useless', async () => {
      await login(makeService(), await idToken({ sub: 'pkce' }));

      const exchange = stub.calls.find((call) => call.url.endsWith('/token'));
      const body = new URLSearchParams(exchange!.body!);

      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code_verifier')).toBeTruthy();
      expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    });

    it('reports a refusal without echoing the provider’s error to the browser', async () => {
      const service = makeService();
      const { handshake } = await service.beginLogin('/');
      stub.tokenStatus = 400;
      stub.tokenResponse = { error: 'invalid_grant', error_description: 'code already used' };

      await expect(
        service.completeLogin({ code: 'used', state: handshake.state }, handshake),
      ).rejects.toThrow(/rejected this sign-in/i);
    });

    it('says so plainly when no ID token comes back', async () => {
      const service = makeService();
      const { handshake } = await service.beginLogin('/');
      stub.tokenResponse = { access_token: 'only-this' };

      await expect(
        service.completeLogin({ code: 'x', state: handshake.state }, handshake),
      ).rejects.toThrow(/no ID token/i);
    });
  });

  // -------------------------------------------------------------------------

  describe('provisioning', () => {
    it('makes the very first user an admin, so an SSO-only instance is reachable', async () => {
      const { principal } = await login(
        makeService(),
        await idToken({ sub: 'first', preferred_username: 'alice' }),
      );

      expect(principal).toMatchObject({ username: 'alice', role: 'admin' });
    });

    it('gives everyone after that the default role', async () => {
      const service = makeService();
      await login(service, await idToken({ sub: 'first', preferred_username: 'alice' }));

      const { principal } = await login(
        service,
        await idToken({ sub: 'second', preferred_username: 'bob' }),
      );
      expect(principal.role).toBe('viewer');
    });

    /**
     * Keyed on `sub`, never email: addresses get reassigned between people, and
     * matching on one would hand a new joiner the previous holder's access.
     */
    it('recognises a returning user whose email has changed', async () => {
      const service = makeService();
      const first = await login(
        service,
        await idToken({ sub: 'stable', preferred_username: 'carol', email: 'carol@old.example' }),
      );
      const second = await login(
        service,
        await idToken({ sub: 'stable', preferred_username: 'carol', email: 'carol@new.example' }),
      );

      expect(second.principal.userId).toBe(first.principal.userId);
      expect(await prisma.user.count()).toBe(1);
    });

    it('does not collide with an existing username', async () => {
      await prisma.user.create({
        data: { username: 'dave', provider: 'local', role: 'viewer', passwordHash: 'x' },
      });

      const { principal } = await login(
        makeService(),
        await idToken({ sub: 'dave-sso', preferred_username: 'dave' }),
      );

      expect(principal.username).not.toBe('dave');
      expect(principal.username).toMatch(/^dave-/);
    });

    it('refuses a deactivated account', async () => {
      const service = makeService();
      const { principal } = await login(service, await idToken({ sub: 'gone' }));
      await prisma.user.update({ where: { id: principal.userId }, data: { isActive: false } });

      await expect(login(service, await idToken({ sub: 'gone' }))).rejects.toThrow(/deactivated/i);
    });

    it('provisions with no password, so the local path can never accept them', async () => {
      const { principal } = await login(makeService(), await idToken({ sub: 'sso-only' }));
      const user = await prisma.user.findUniqueOrThrow({ where: { id: principal.userId } });

      expect(user.passwordHash).toBeNull();
      expect(user.provider).toBe('oidc');
    });
  });

  // -------------------------------------------------------------------------

  describe('role mapping', () => {
    const mapped = {
      OIDC_ROLE_CLAIM: 'groups',
      OIDC_ROLE_MAP: '{"hub-admins":"admin","hub-staff":"editor"}',
    };

    it('maps a claim value onto a role', async () => {
      const service = makeService(mapped);
      await login(service, await idToken({ sub: 'first' })); // burns the admin bootstrap

      const { principal } = await login(
        service,
        await idToken({ sub: 'staffer', groups: ['hub-staff'] }),
      );
      expect(principal.role).toBe('editor');
    });

    it('takes the most privileged of several groups', async () => {
      // The reverse would mean adding somebody to a second group demotes them.
      const service = makeService(mapped);
      await login(service, await idToken({ sub: 'first' }));

      const { principal } = await login(
        service,
        await idToken({ sub: 'both', groups: ['hub-staff', 'hub-admins'] }),
      );
      expect(principal.role).toBe('admin');
    });

    it('reads a space-separated claim, as some providers send', async () => {
      const service = makeService(mapped);
      await login(service, await idToken({ sub: 'first' }));

      const { principal } = await login(
        service,
        await idToken({ sub: 'spaced', groups: 'other hub-staff' }),
      );
      expect(principal.role).toBe('editor');
    });

    /**
     * With a claim configured the provider is authoritative, so losing a group
     * there must take effect here at the next login rather than whenever
     * somebody notices.
     */
    it('demotes on the next login when the group is gone', async () => {
      const service = makeService(mapped);
      await login(service, await idToken({ sub: 'first' }));
      await login(service, await idToken({ sub: 'demoted', groups: ['hub-admins'] }));

      const { principal } = await login(service, await idToken({ sub: 'demoted', groups: [] }));
      expect(principal.role).toBe('viewer');
    });

    /**
     * Without a claim configured, roles are managed locally — and overwriting
     * one here would silently undo an operator's decision.
     */
    it('leaves a locally assigned role alone when no claim is configured', async () => {
      const service = makeService();
      await login(service, await idToken({ sub: 'first' }));

      const { principal } = await login(service, await idToken({ sub: 'promoted' }));
      await prisma.user.update({ where: { id: principal.userId }, data: { role: 'editor' } });

      const again = await login(service, await idToken({ sub: 'promoted' }));
      expect(again.principal.role).toBe('editor');
    });
  });

  // -------------------------------------------------------------------------

  describe('discovery', () => {
    it('refuses a document whose issuer disagrees with the configuration', async () => {
      stub.discovery = discoveryDocument({ issuer: 'https://somewhere-else.example' });
      await expect(makeService().beginLogin('/')).rejects.toThrow(/declares issuer/i);
    });

    /**
     * The token endpoint receives this client's secret, so a document naming a
     * host of its choosing would be a credential-harvesting redirect.
     */
    it('refuses an endpoint on another origin', async () => {
      stub.discovery = discoveryDocument({ token_endpoint: 'https://evil.example/token' });
      await expect(makeService().beginLogin('/')).rejects.toThrow(/points at https:\/\/evil/i);
    });

    it('refuses a plaintext token endpoint outside loopback', async () => {
      stub.discovery = discoveryDocument({
        issuer: 'http://idp.example.com',
        authorization_endpoint: 'http://idp.example.com/authorize',
        token_endpoint: 'http://idp.example.com/token',
        jwks_uri: 'http://idp.example.com/jwks',
      });

      await expect(
        makeService({ OIDC_ISSUER_URL: 'http://idp.example.com' }).beginLogin('/'),
      ).rejects.toThrow(/not.*HTTPS/i);
    });

    it('says which field is missing rather than failing at login time', async () => {
      stub.discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` };
      await expect(makeService().beginLogin('/')).rejects.toThrow(/token_endpoint/);
    });

    it('reports an unreachable provider clearly', async () => {
      stub.discoveryStatus = 503;
      await expect(makeService().beginLogin('/')).rejects.toThrow(/HTTP 503/);
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * An open redirect on a login endpoint is the classic way to build a phishing
 * URL that genuinely starts on the victim's own domain.
 */
describe('safeReturnTo', () => {
  it.each(['/', '/inventory', '/items/abc?tab=history'])('keeps the in-app path %j', (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    'http://evil.example/path',
    'javascript:alert(1)',
    '/path\r\nLocation: https://evil.example',
  ])('refuses %j', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });

  it('falls back to the root when absent', () => {
    expect(safeReturnTo(undefined)).toBe('/');
  });
});
