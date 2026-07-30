import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';

/**
 * Matching sits above both halves it joins: a channel (connectors) and the
 * catalogue, writing through the inventory module rather than around it. It owns
 * no persistence of its own, which is why there is no repository here — the
 * proposal is pure and the confirmation delegates.
 */
@Module({
  imports: [CatalogModule, ConnectorsModule, InventoryModule],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
