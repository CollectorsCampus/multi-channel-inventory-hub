import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SyncEventService } from './sync-event.service';
import { AlertsService } from './alerts.service';
import { OutboundWorker } from './outbound.worker';
import { InboundWorker } from './inbound.worker';
import { ReconcileService } from './reconcile.service';
import { ReconcileWorker } from './reconcile.worker';
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
  imports: [ConnectorsModule, InventoryModule],
  controllers: [SyncActivityController],
  providers: [
    SyncEventService,
    SyncActivityService,
    AlertsService,
    ReconcileService,
    OutboundWorker,
    InboundWorker,
    ReconcileWorker,
  ],
  exports: [SyncEventService, ReconcileService, AlertsService],
})
export class SyncModule {}
