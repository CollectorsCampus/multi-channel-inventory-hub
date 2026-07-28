import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SyncModule } from '../sync/sync.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { ChannelFilesService } from './channel-files.service';

/**
 * InventoryModule and SyncModule arrive with file transport (ADR 0002): an
 * export needs the desired listed quantity for every allocation, and both
 * directions are audited. `InboundQueue` comes from the global QueueModule.
 */
@Module({
  imports: [ConnectorsModule, InventoryModule, SyncModule],
  controllers: [ChannelsController],
  providers: [ChannelsService, ChannelFilesService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
