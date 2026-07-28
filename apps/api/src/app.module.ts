import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { InventoryModule } from './inventory/inventory.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { CatalogModule } from './catalog/catalog.module';
import { QueueModule } from './queue/queue.module';
import { SyncModule } from './sync/sync.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { HealthController } from './health/health.controller';

// Static SPA serving lives in bootstrap.ts (`serveSpa`), not here: it needs the
// history-API fallback registered after Nest's own routes, which a module
// import cannot express.

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    PrismaModule,
    QueueModule,
    AuthModule,
    InventoryModule,
    ConnectorsModule,
    CatalogModule,
    SyncModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
