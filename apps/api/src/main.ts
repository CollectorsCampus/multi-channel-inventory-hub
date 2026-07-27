import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      // Webhook signature verification needs the byte-exact body
      // (TECHNICAL_DESIGN.md §5), so keep the raw buffer around for the
      // ingress routes added in Phase 3.
      bodyLimit: 8 * 1024 * 1024,
    }),
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

  // 0.0.0.0 so the container is reachable from outside it.
  await app.listen({ port, host: '0.0.0.0' });

  Logger.log(`Listening on :${port} — API docs at /api/docs`, 'Bootstrap');
}

void bootstrap();
