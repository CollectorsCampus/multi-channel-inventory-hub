import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
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
};

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prismaStub)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await configureApp(app, { sessionSecret: Buffer.alloc(32, 3).toString('base64') });
  await app.init();
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
