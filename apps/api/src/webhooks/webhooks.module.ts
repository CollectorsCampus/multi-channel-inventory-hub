import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [ConnectorsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
