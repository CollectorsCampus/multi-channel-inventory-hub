import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { IntakeService } from './intake.service';
import { BulkAllocateService } from './bulk-allocate.service';
import { CatalogModule } from '../catalog/catalog.module';
import { AlertsModule } from '../sync/alerts.module';
import { PricingModule } from '../pricing/pricing.module';

@Module({
  // `AlertsModule` rather than `SyncModule`: sync imports *this* module, so
  // reaching the whole of it would be a cycle. Alerts has no dependencies of
  // its own, which is what makes the split work.
  // PricingModule for MarketPriceService: a bulk allocation prices an item
  // the sweep has never seen, and it must do so through the same code the
  // sweep uses. Checked for a cycle first — pricing imports catalog, queue and
  // alerts, none of which reach back here.
  imports: [CatalogModule, AlertsModule, PricingModule],
  controllers: [InventoryController],
  providers: [InventoryService, IntakeService, BulkAllocateService],
  exports: [InventoryService, IntakeService, BulkAllocateService],
})
export class InventoryModule {}
