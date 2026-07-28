import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { InventoryModule } from './inventory/inventory.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { CatalogModule } from './catalog/catalog.module';
import { HealthController } from './health/health.controller';

/**
 * The API container also serves the built SPA (TECHNICAL_DESIGN.md §2), so a
 * self-hoster runs one image. In development the SPA is served by Vite on its
 * own port and this is skipped.
 */
const webRoot = process.env.WEB_ROOT ?? join(__dirname, '..', '..', 'web', 'dist');
const serveStatic = existsSync(webRoot)
  ? [
      ServeStaticModule.forRoot({
        rootPath: webRoot,
        // Everything under /api is handled by controllers; without this the
        // static middleware would swallow unmatched API routes and return
        // index.html with a 200, turning 404s into confusing blank pages.
        exclude: ['/api/{*splat}'],
      }),
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    InventoryModule,
    ConnectorsModule,
    CatalogModule,
    ...serveStatic,
  ],
  controllers: [HealthController],
})
export class AppModule {}
