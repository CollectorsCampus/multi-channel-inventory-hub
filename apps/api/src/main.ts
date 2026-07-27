import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { AppModule } from './app.module';

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

  await app.register(fastifyCookie, { secret: config.get<string>('SESSION_SECRET') });

  await app.register(fastifyHelmet, {
    // The SPA is same-origin; CSP defaults would block the Swagger UI assets.
    contentSecurityPolicy: isProduction
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

  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

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
