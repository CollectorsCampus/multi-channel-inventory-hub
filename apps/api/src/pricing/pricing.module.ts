import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { QueueModule } from '../queue/queue.module';
import { AlertsModule } from '../sync/alerts.module';
import { PricingController } from './pricing.controller';
import { RepriceService } from './reprice.service';
import { MarketPriceService } from './market-prices.service';
import { RepriceWorker } from './reprice.worker';

/**
 * Its own module because it sits across two seams nothing else spans: the
 * catalog sources (where market prices come from) and the outbound queue
 * (where applied prices go). Folding it into either would drag the other in.
 */
@Module({
  imports: [CatalogModule, QueueModule, AlertsModule],
  controllers: [PricingController],
  providers: [RepriceService, MarketPriceService, RepriceWorker],
  // Exported for BulkAllocateService: an item being put on its first channel
  // has no stored figure, because the sweep only prices allocated ones.
  exports: [MarketPriceService],
})
export class PricingModule {}
