import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Options for `NestFactory.create` / `createNestApplication`.
 *
 * These cannot live in `configureApp` — Nest reads them while constructing the
 * application, before any of it exists to configure. They are exported instead
 * so main.ts and the tests pass the same object rather than each spelling it
 * out, because this is precisely where the two drifted before: production set
 * `rawBody` and the tests did not.
 *
 * `rawBody` populates `request.rawBody` with the byte-exact body alongside the
 * parsed one. Webhook signature verification needs it (§5): parsing and
 * re-serializing changes whitespace and key order, and the HMAC then never
 * matches. Without it every delivery fails closed at "Missing request body" —
 * which looks like a signature problem and is not one.
 */
export const NEST_APP_OPTIONS = { rawBody: true } as const;

/**
 * Everything that turns a bare Nest application into *this* application.
 *
 * Shared by main.ts and the boot smoke test rather than duplicated, so the two
 * cannot drift. That matters more than it looks: the failures this configures
 * around — a missing `class-validator` for ValidationPipe, a missing
 * `@fastify/static` for the SPA — are invisible to typechecking and to DI
 * resolution. They only appear when an app is actually initialized, so the test
 * is only meaningful if it initializes the same configuration production does.
 */
export async function configureApp(
  app: NestFastifyApplication,
  options: { sessionSecret?: string; isProduction?: boolean } = {},
): Promise<NestFastifyApplication> {
  await app.register(fastifyCookie, { secret: options.sessionSecret });

  await app.register(fastifyHelmet, {
    // The SPA is same-origin; the default CSP would block the Swagger UI assets.
    contentSecurityPolicy: options.isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            scriptSrc: ["'self'"],
            // Helmet merges its default directives in, and the default set
            // includes `upgrade-insecure-requests` — which force-upgrades every
            // subresource fetch to https. Browsers exempt localhost, so this
            // was invisible until the first LAN deployment: on
            // http://192.168.x.x the JS and CSS were requested over https
            // against a server speaking http, failed with ERR_SSL_PROTOCOL_ERROR,
            // and the app was a blank page. The directive buys nothing here —
            // every source above is 'self', so subresources inherit the page's
            // scheme and an https deployment cannot have mixed content anyway.
            upgradeInsecureRequests: null,
          },
        }
      : false,
  });

  /**
   * Accept a raw CSV body.
   *
   * File-based channels (ADR 0002) upload a marketplace export as the request
   * body. Fastify rejects a content type it has no parser for with a 415, so
   * without this the upload endpoint is unreachable however correct it is.
   *
   * `text/csv` is deliberately not one of the CORS-safelisted content types, so
   * a cross-site POST of one triggers a preflight and never reaches the handler
   * — the upload path inherits that protection on top of the CSRF token the
   * auth guard already demands.
   */
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('text/csv', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

  // Health checks sit outside /api so container probes do not depend on the
  // API's versioning or prefix.
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  return app;
}

/**
 * Serve the built SPA, with a history-API fallback.
 *
 * The fallback is the whole point. A single-page app owns its own routes, so a
 * request for `/intake` or `/items/abc` has no file behind it and no controller
 * to match — without this it 404s, and every bookmark, refresh and shared link
 * into the app is broken. Client-side navigation hides that completely, so it
 * only shows up when someone types a URL.
 *
 * Registered explicitly rather than through ServeStaticModule because that
 * module's Fastify path did not install a fallback with our route layout, and
 * an SPA silently losing deep links is not something to leave to a
 * configuration flag whose behaviour we cannot see.
 *
 * Must be called after `app.init()`, so Nest's own routes are registered first
 * and only genuinely unmatched requests reach here.
 */
export function serveSpa(app: NestFastifyApplication, webRoot: string): boolean {
  const indexPath = join(webRoot, 'index.html');
  if (!existsSync(indexPath)) return false;

  // Read once. The build is immutable inside the container, and this avoids a
  // disk read on every deep link.
  const indexHtml = readFileSync(indexPath, 'utf8');

  app.useStaticAssets({ root: webRoot, wildcard: false });

  const fastify = app.getHttpAdapter().getInstance();

  // A wildcard GET rather than setNotFoundHandler: Nest already owns Fastify's
  // not-found handler, and replacing it throws. Fastify's router gives static
  // routes precedence over wildcards regardless of registration order, so every
  // real route still wins — this only catches what nothing else claimed.
  fastify.get('/*', (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    // API and health routes must keep returning a real 404. Handing them
    // index.html would turn a missing endpoint into a 200 full of HTML, which
    // is far harder to diagnose than the 404 it replaced.
    if (path.startsWith('/api') || path.startsWith('/health')) {
      void reply.status(404).send({ message: 'Not Found', statusCode: 404 });
      return;
    }

    void reply.type('text/html').send(indexHtml);
  });

  return true;
}
