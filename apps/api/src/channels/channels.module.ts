import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';

@Module({
  imports: [ConnectorsModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
