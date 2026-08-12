import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AlertsService } from './alerts.service';
import { SyslogService } from './syslog.service';
import { EmailService } from './email.service';

/**
 * Alerts on their own, so anything can raise one.
 *
 * `AlertsService` lived in `SyncModule`, which imports `InventoryModule` — so
 * the ledger could not report a problem without making the two modules import
 * each other. Nest resolves that only with `forwardRef`, which works and then
 * quietly turns every future construction-time dependency between them into a
 * runtime undefined (the same reasoning as `CatalogIngestModule`).
 *
 * A module of its own keeps the graph acyclic and costs nothing: the service
 * depends on `PrismaService` and nothing else, which is why it was always
 * movable. `SyncModule` re-exports it so its existing consumers are unchanged.
 */
@Module({
  // ConnectorsModule for the CredentialStore the SMTP password lives in —
  // provider-only, so no cycle risk.
  imports: [ConnectorsModule],
  // SyslogService and EmailService live here rather than in SyncModule for
  // the same reason AlertsService does: both notification sinks hang off the
  // alert writer, and SyncEventService over in SyncModule needs syslog too.
  providers: [AlertsService, SyslogService, EmailService],
  exports: [AlertsService, SyslogService, EmailService],
})
export class AlertsModule {}
