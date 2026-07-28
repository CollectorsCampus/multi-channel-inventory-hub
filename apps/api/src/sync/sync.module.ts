import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SyncEventService } from './sync-event.service';
import { OutboundWorker } from './outbound.worker';

/**
 * The consuming half of the sync engine.
 *
 * Separate from QueueModule so producers (InventoryService) need not depend on
 * consumers (which depend on InventoryService in turn). Enqueue and perform sit
 * on opposite sides of the queue for exactly this reason.
 */
@Module({
  imports: [ConnectorsModule, InventoryModule],
  providers: [SyncEventService, OutboundWorker],
  exports: [SyncEventService],
})
export class SyncModule {}
