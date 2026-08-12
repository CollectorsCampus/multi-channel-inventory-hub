import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { SyslogService } from './syslog.service';

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
  // SyslogService lives here rather than in SyncModule for the same reason
  // AlertsService does: it depends on Prisma and nothing else, and both the
  // alert writer here and SyncEventService over there need to reach it.
  providers: [AlertsService, SyslogService],
  exports: [AlertsService, SyslogService],
})
export class AlertsModule {}
