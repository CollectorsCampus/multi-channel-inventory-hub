import { Module } from '@nestjs/common';
import { ConnectorRegistry } from './connector-registry.service';
import { CredentialStore } from './credential-store.service';
import { ChannelContextFactory } from './channel-context.service';

@Module({
  providers: [ConnectorRegistry, CredentialStore, ChannelContextFactory],
  exports: [ConnectorRegistry, CredentialStore, ChannelContextFactory],
})
export class ConnectorsModule {}
