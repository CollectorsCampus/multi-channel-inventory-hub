import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { IntakeService } from './intake.service';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [CatalogModule],
  controllers: [InventoryController],
  providers: [InventoryService, IntakeService],
  exports: [InventoryService, IntakeService],
})
export class InventoryModule {}
