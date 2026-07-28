import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { InventoryModule } from './inventory/inventory.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { CatalogModule } from './catalog/catalog.module';
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
    AuthModule,
    InventoryModule,
    ConnectorsModule,
    CatalogModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
