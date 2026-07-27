import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';

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
          },
        }
      : false,
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
