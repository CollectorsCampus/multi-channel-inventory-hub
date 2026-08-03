import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { IntakeService } from './intake.service';
import { CatalogModule } from '../catalog/catalog.module';
import { AlertsModule } from '../sync/alerts.module';

@Module({
  // `AlertsModule` rather than `SyncModule`: sync imports *this* module, so
  // reaching the whole of it would be a cycle. Alerts has no dependencies of
  // its own, which is what makes the split work.
  imports: [CatalogModule, AlertsModule],
  controllers: [InventoryController],
  providers: [InventoryService, IntakeService],
  exports: [InventoryService, IntakeService],
})
export class InventoryModule {}
