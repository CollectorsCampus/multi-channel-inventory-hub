import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, configureApp, serveSpa } from './bootstrap';

/**
 * The published version, read from the package manifest rather than repeated.
 *
 * A second copy of a version string is a copy that gets forgotten at the one
 * moment it matters — a release. The manifest sits beside `dist/` in both the
 * container and a local build, so the relative path holds in both.
 *
 * Wrapped because this is only the label on an API document: a packaging change
 * that moved the manifest should not stop the server booting.
 */
function apiVersion(): string {
  try {
    const manifest = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 8 * 1024 * 1024,
    }),
    NEST_APP_OPTIONS,
  );

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);
  const isProduction = config.get<string>('NODE_ENV') === 'production';

  await configureApp(app, {
    sessionSecret: config.get<string>('SESSION_SECRET'),
    isProduction,
  });

  app.enableShutdownHooks();

  const openapi = new DocumentBuilder()
    .setTitle('Multi-Channel Inventory Hub')
    .setDescription('Self-hostable multi-channel inventory sync.')
    .setVersion(apiVersion())
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'apiKey')
    .addCookieAuth('hub_session')
    .build();

  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openapi), {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });

  // The API container also serves the built SPA (§2), so a self-hoster runs one
  // image. In development Vite serves it on its own port and this is skipped.
  // Registered after init() so Nest's routes win over the fallback.
  await app.init();
  const webRoot = config.get<string>('WEB_ROOT') ?? join(__dirname, '..', '..', 'web', 'dist');
  Logger.log(
    serveSpa(app, webRoot) ? `Serving SPA from ${webRoot}` : `No SPA build at ${webRoot}`,
    'Bootstrap',
  );

  // 0.0.0.0 so the container is reachable from outside it.
  await app.listen({ port, host: '0.0.0.0' });

  Logger.log(`Listening on :${port} — API docs at /api/docs`, 'Bootstrap');
}

void bootstrap();
