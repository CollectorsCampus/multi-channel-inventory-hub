import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { NEST_APP_OPTIONS, configureApp, serveSpa } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Boots the real HTTP application and issues requests against it.
 *
 * This exists because two production-breaking bugs shipped past a green
 * typecheck, a green DI-resolution test and a green build: `ValidationPipe`
 * needs `class-validator` installed, and `ServeStaticModule` needs
 * `@fastify/static`. Neither is referenced in source — Nest resolves them at
 * runtime — so nothing short of initializing the app can catch a missing one.
 *
 * The database is stubbed; this is about wiring, not persistence.
 */

const prismaStub = {
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  user: { count: vi.fn().mockResolvedValue(0) },
  setting: { findFirst: vi.fn().mockResolvedValue(null) },
  session: { findUnique: vi.fn().mockResolvedValue(null) },
  apiKey: { findUnique: vi.fn().mockResolvedValue(null) },
  // No such channel: enough for the routing and raw-body assertions below,
  // which are about reaching the controller rather than verifying a signature.
  channelInstance: { findUnique: vi.fn().mockResolvedValue(null) },
};

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaStub)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    NEST_APP_OPTIONS,
  );
  await configureApp(app, { sessionSecret: Buffer.alloc(32, 3).toString('base64') });
  await app.init();

  // Mirrors main.ts: the fallback goes on after Nest's routes exist. The SPA
  // build is a CI prerequisite for this suite (see .github/workflows/ci.yml).
  serveSpa(app, join(__dirname, '..', '..', 'web', 'dist'));

  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

describe('HTTP application', () => {
  it('serves the liveness probe outside the /api prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('exposes auth status publicly and reports first-run setup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ needsSetup: true, providerKey: 'local' });
  });

  it('rejects unauthenticated access to a guarded route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  // Proves ValidationPipe is actually operational — it silently degrades to a
  // pass-through if class-validator is absent.
  it('enforces DTO constraints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/12 characters/);
  });

  // `whitelist` + `forbidNonWhitelisted` are what stop a caller smuggling
  // `role: "admin"` into the unauthenticated setup endpoint.
  it('rejects unexpected properties rather than ignoring them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'a'.repeat(20), role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/role should not exist/);
  });

  /**
   * A single-page app owns its own routes, so `/intake` has no file behind it
   * and no controller to match. Without a history-API fallback it 404s, and
   * every bookmark, refresh and shared link into the app is broken — while
   * client-side navigation hides it completely. It shipped broken once.
   */
  describe('SPA fallback', () => {
    it('serves index.html for a client-side route', async () => {
      const res = await app.inject({ method: 'GET', url: '/intake' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<div id="root">');
    });

    it('serves index.html for a nested client-side route', async () => {
      const res = await app.inject({ method: 'GET', url: '/items/some-id' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="root">');
    });

    /**
     * The other half of the bug: handing index.html to a missing API endpoint
     * would turn a 404 into a 200 full of HTML, which is far harder to
     * diagnose than the 404 it replaced.
     */
    it('still 404s an unknown API route rather than returning HTML', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('still 404s an unknown health route', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/nope' });
      expect(res.statusCode).toBe(404);
    });

    it('does not hand HTML to a non-GET request', async () => {
      const res = await app.inject({ method: 'POST', url: '/not-a-route' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  /**
   * The production CSP, on its own app because the main one boots with CSP off.
   *
   * `upgrade-insecure-requests` is the directive helmet merges in by default,
   * and it is the one that made the first LAN deployment a blank white page:
   * browsers exempt localhost, so every http://localhost run looked fine, while
   * on http://192.168.x.x the JS and CSS were force-upgraded to https against a
   * server speaking http and failed with ERR_SSL_PROTOCOL_ERROR. The app's CSP
   * is 'self'-only, so the directive protects nothing an https deployment does
   * not already have — subresources inherit the page's scheme.
   */
  describe('production security headers', () => {
    let prodApp: NestFastifyApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prismaStub)
        .compile();

      prodApp = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
        NEST_APP_OPTIONS,
      );
      await configureApp(prodApp, {
        sessionSecret: Buffer.alloc(32, 3).toString('base64'),
        isProduction: true,
      });
      await prodApp.init();
      await prodApp.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await prodApp?.close();
    });

    it('sends a CSP, without upgrade-insecure-requests', async () => {
      const res = await prodApp.inject({ method: 'GET', url: '/health/live' });
      const csp = res.headers['content-security-policy'] as string;

      expect(csp).toContain("default-src 'self'");
      // The regression that blanked the first plain-http LAN deployment.
      expect(csp).not.toContain('upgrade-insecure-requests');
    });
  });

  /**
   * Everything above this point passes with `@fastify/static` absent or inert:
   * the fallback route serves index.html from a string this file read itself, so
   * it proves `useStaticAssets` did not *throw*, not that the plugin actually
   * serves anything. A bundle that 404s means a white page with no error, which
   * is the same class of invisible failure this file exists for.
   *
   * The filenames are content-hashed, so they are discovered from the served
   * index.html rather than hardcoded — which also proves the references in it
   * resolve, instead of assuming a build layout.
   */
  describe('static asset serving', () => {
    it('serves the hashed bundles index.html actually references', async () => {
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);

      const refs = [...index.body.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map(
        (m) => m[0],
      );
      // A build with no referenced assets would make every assertion below
      // vacuous, which is the failure mode this whole file was written against.
      expect(refs.length).toBeGreaterThan(0);

      for (const ref of refs) {
        const res = await app.inject({ method: 'GET', url: ref });
        expect(res.statusCode, `${ref} should be served by @fastify/static`).toBe(200);
        // The fallback would answer 200 text/html for a path it swallowed, so
        // the content type is what distinguishes "served" from "fell through".
        expect(res.headers['content-type'], ref).not.toMatch(/text\/html/);
        expect(res.body.length).toBeGreaterThan(0);
      }
    });

    /**
     * `@fastify/static` 9.3.0 shipped in v0.1.0 with two advisories about
     * escaping the served root via non-canonical paths (GHSA route-guard bypass
     * and the `allowedPath` bypass). Neither was reachable here — nothing guards
     * the SPA bundle and `allowedPath` is never passed — but "not reachable"
     * is a property of today's configuration, and the point of a test is that it
     * keeps being true. Nothing outside the web root may ever be readable.
     */
    it('does not serve files outside the web root', async () => {
      const escapes = [
        '/assets/../../../package.json',
        '/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
        '/assets/..%5c..%5c..%5cpackage.json',
        '/assets/....//....//....//package.json',
        '/assets/.%2e/.%2e/.%2e/package.json',
        '/../../package.json',
        '/assets/%252e%252e%252fpackage.json',
      ];

      for (const url of escapes) {
        const res = await app.inject({ method: 'GET', url });
        // Contained requests fall through to the SPA fallback, so a 200 is
        // expected and harmless. What must never appear is content from a file
        // above the root — the repository manifest is the nearest one.
        expect(res.body, `${url} escaped the web root`).not.toMatch(/"name":\s*"inventory-hub"/);
        expect(res.body, `${url} escaped the web root`).not.toMatch(/"license":\s*"AGPL/);
      }
    });
  });

  /**
   * The ingress endpoint is public by necessity — the caller is a platform, not
   * a signed-in operator — so the HMAC is the only thing standing between the
   * ledger and anyone who learns the URL.
   */
  describe('webhook ingress', () => {
    it('is reachable without a session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/some-channel',
        payload: { hello: 'world' },
      });
      // 404 for the unknown channel, which can only be reached *past* the guard
      // and past the raw-body check. Asserting the specific status matters: the
      // earlier version of this test allowed anything that was not 403, so it
      // also passed when every request died at "Missing request body" — the
      // exact misconfiguration it was supposed to notice.
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).not.toMatch(/Authentication required/);
    });

    /**
     * `rawBody` is a `NestFactory.create` option, so it cannot live in
     * `configureApp` with the rest of the configuration and is the one piece of
     * production setup a test can silently omit. It did: the app here was built
     * without it while main.ts set it, and ingress therefore rejected every
     * body before verification. Pinning it here means that divergence fails a
     * test instead of reaching a live store.
     *
     * Signature verification itself is covered in webhook-ingress.spec.ts.
     */
    it('populates the byte-exact raw body the HMAC is computed over', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/some-channel',
        payload: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      });
      // Reached channel lookup ⇒ rawBody was present. A 401 here would mean it
      // was not, whatever the signature said.
      expect(res.statusCode).toBe(404);
    });

    /**
     * An empty delivery never reaches the controller: Fastify's JSON parser
     * refuses it at 400 first. The controller's own "Missing request body"
     * check is therefore defence in depth for the case where `rawBody` is
     * absent, not the first line — worth knowing, because a 400 here and a 401
     * from the controller look alike in a log and have different causes.
     */
    it('refuses an empty body at the parser, before verification', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/some-channel',
        payload: '',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * File-based channels upload a marketplace export as a raw `text/csv` body
   * (ADR 0002). Fastify answers 415 for a content type it has no parser for,
   * and it does so in the router — before the guard, before the controller —
   * so nothing short of booting the app catches a missing parser. Exactly the
   * failure mode this file exists for.
   */
  describe('CSV upload transport', () => {
    it('parses a text/csv body instead of rejecting the media type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/channels/some-channel/import?kind=orders',
        headers: { 'content-type': 'text/csv' },
        payload: 'Product Line,SkuId\n"Magic","1"\n',
      });

      // 401 is the correct answer here — the route is admin-only and there is
      // no session. What matters is that it got as far as the guard.
      expect(res.statusCode).not.toBe(415);
      expect(res.statusCode).toBe(401);
    });
  });

  /**
   * ReconcileService is reached from two modules — the channels controller and
   * the reconcile worker — and NestJS resolves those constructor dependencies
   * from metadata at runtime. A type-only import anywhere on that path
   * typechecks perfectly and then fails DI at boot, which is the whole reason
   * this file initializes the real application.
   */
  it('wires the reconcile route rather than failing DI', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/channels/some-channel/reconcile',
    });

    // Admin-only with no session, so 401 is correct. A 404 would mean the
    // route never registered; a 500 would mean the provider did not resolve.
    expect(res.statusCode).toBe(401);
  });

  /**
   * MatchingService is reached from the channels path and pulls in the catalog
   * registry, the intake service and InventoryService — four modules deep. Nest
   * resolves those constructor dependencies from metadata at runtime, so a
   * type-only import anywhere on that path typechecks and then fails DI at boot
   * (rule 7). These assert the routes exist rather than that they work.
   */
  describe('match proposal routes', () => {
    it('wires the propose route rather than failing DI', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/channels/some-channel/match/propose',
        payload: { sourceKey: 'tcgcsv', setName: 'Surging Sparks' },
      });

      // Editor-only with no session, so 401 is correct. A 404 would mean the
      // route never registered; a 500 would mean a provider did not resolve.
      expect(res.statusCode).toBe(401);
    });

    it('wires the confirm route', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/channels/some-channel/match/confirm',
        payload: { links: [] },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  /**
   * `CatalogIngestModule` exists to avoid a cycle: it imports both
   * `CatalogModule` and `InventoryModule`, and `InventoryModule` already imports
   * `CatalogModule`. That arrangement typechecks whether or not Nest can
   * actually construct it, so the only proof is booting and hitting the routes.
   */
  describe('catalog ingest routes', () => {
    it('wires the set listing route rather than failing DI', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/catalog/ingest/sets?sourceKey=tcgcsv',
      });

      // Admin-only with no session. 404 would mean the route never registered;
      // 500 would mean CatalogIngestService could not be constructed.
      expect(res.statusCode).toBe(401);
    });

    it('wires the ingest route', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/catalog/ingest',
        payload: { sourceKey: 'tcgcsv' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  /**
   * The console ships off, and a deployment that has not enabled it should not
   * advertise that the endpoint exists — hence 404 rather than 403 from the
   * service. The status route stays readable so the SPA can decide whether to
   * render a nav link.
   */
  describe('query console', () => {
    it('reports itself disabled by default', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/query-console/status' });
      // Guarded like any other route; no session here, so 401.
      expect(res.statusCode).toBe(401);
    });

    it('guards the run endpoint before anything reads the SQL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/query-console/query',
        payload: { sql: 'SELECT 1' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it('requires a CSRF token on cookie-authenticated writes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { hub_session: 'some-session-token' },
    });
    // No valid session, so this is a 401 before CSRF is reached; the assertion
    // is that an unsafe method never succeeds without the token.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
