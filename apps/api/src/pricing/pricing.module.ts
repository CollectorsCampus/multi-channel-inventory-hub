import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { QueueModule } from '../queue/queue.module';
import { AlertsModule } from '../sync/alerts.module';
import { PricingController } from './pricing.controller';
import { RepriceService } from './reprice.service';
import { RepriceWorker } from './reprice.worker';

/**
 * Its own module because it sits across two seams nothing else spans: the
 * catalog sources (where market prices come from) and the outbound queue
 * (where applied prices go). Folding it into either would drag the other in.
 */
@Module({
  imports: [CatalogModule, QueueModule, AlertsModule],
  controllers: [PricingController],
  providers: [RepriceService, RepriceWorker],
})
export class PricingModule {}
