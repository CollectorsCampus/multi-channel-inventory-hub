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
import { ChannelsModule } from './channels/channels.module';
import { MatchingModule } from './matching/matching.module';
import { QueryConsoleModule } from './query-console/query-console.module';
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
    ChannelsModule,
    MatchingModule,
    // Registered unconditionally; the service reports itself unavailable when
    // ENABLE_QUERY_CONSOLE is off. Conditional module registration would make
    // the route table depend on env, which is far harder to reason about than
    // one endpoint that answers "not enabled".
    QueryConsoleModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
