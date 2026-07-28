import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { configureApp, serveSpa } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 8 * 1024 * 1024,
    }),
    {
      // Webhook signature verification needs the byte-exact body (§5): parsing
      // and re-serializing changes whitespace and key order, and the HMAC then
      // never matches. This populates `request.rawBody` alongside the parsed
      // body so ingress can verify what was actually sent.
      rawBody: true,
    },
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
    .setVersion('0.0.0')
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
