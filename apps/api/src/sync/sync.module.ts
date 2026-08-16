import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SyncEventService } from './sync-event.service';
import { AlertsModule } from './alerts.module';
import { OutboundWorker } from './outbound.worker';
import { InboundWorker } from './inbound.worker';
import { ReconcileService } from './reconcile.service';
import { ReconcileWorker } from './reconcile.worker';
import { SelloutService } from './sellout.service';
import { SelloutWorker } from './sellout.worker';
import { SyncActivityService } from './sync-activity.service';
import { SyncActivityController } from './sync-activity.controller';

/**
 * The consuming half of the sync engine.
 *
 * Separate from QueueModule so producers (InventoryService) need not depend on
 * consumers (which depend on InventoryService in turn). Enqueue and perform sit
 * on opposite sides of the queue for exactly this reason.
 */
@Module({
  imports: [ConnectorsModule, InventoryModule, AlertsModule],
  controllers: [SyncActivityController],
  providers: [
    SyncEventService,
    SyncActivityService,
    ReconcileService,
    OutboundWorker,
    InboundWorker,
    ReconcileWorker,
    SelloutService,
    SelloutWorker,
  ],
  // `AlertsModule` rather than `AlertsService`: Nest will not re-export a
  // provider it does not itself provide, and says so at boot. Exporting the
  // module keeps every existing consumer of `SyncModule` working unchanged
  // now that alerts live somewhere the ledger can reach them too.
  exports: [SyncEventService, ReconcileService, SelloutService, AlertsModule],
})
export class SyncModule {}
