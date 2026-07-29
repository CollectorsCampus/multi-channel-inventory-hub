import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability, type Connector, type Ctx } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { InventoryService } from '../inventory/inventory.service';
import { OutboundQueue } from '../queue/outbound-queue.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
import { SyncEventService } from './sync-event.service';
import { AlertsService } from './alerts.service';
import {
  correctableDrifts,
  diffLiveState,
  summarize,
  type ObservedListing,
  type ReconcilableAllocation,
  type ReconcileReport,
} from './reconcile';

/**
 * Reconciliation — TECHNICAL_DESIGN.md §6.
 *
 * The safety net the rest of the design leans on. Every other mechanism assumes
 * the sync loop worked: a webhook arrived, a push landed, a file was uploaded.
 * This is what notices when one of them quietly did not — a dropped webhook, a
 * push that failed after its last retry, a seller editing a listing on the
 * platform directly, or, for TCGPlayer, a pull sheet nobody uploaded before
 * shipping.
 *
 * All the judgement lives in `reconcile.ts` as pure functions. This class does
 * the I/O around them: fetch, diff, record, alert, and — only when the operator
 * has opted in — push our numbers back.
 *
 * **The ledger is never rewritten from a channel.** §6 is explicit, and it is
 * the rule that keeps a platform reporting a wrong number from silently
 * becoming the source of truth. Auto-correction runs in one direction only.
 */

/** Chosen to stay well inside what a single GraphQL `nodes(ids:)` call will take. */
const BATCH_SIZE = 100;

/** Marks the alert this service owns, so it does not close ones it did not raise. */
const ALERT_SOURCE = 'reconcile-sweep';

export interface ReconcileOutcome {
  channelInstanceId: string;
  channelName: string;
  report: ReconcileReport;
  summary: string;
  /** Allocations re-pushed because the channel has auto-correct enabled. */
  corrected: number;
  ranAt: Date;
}

export interface ReconcileOptions {
  /** Off by default; §6's price policy is last-write-wins. */
  comparePrices?: boolean;
}

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  /**
   * Paces calls at the connector's declared rate.
   *
   * Reconciliation runs on the synchronous path rather than through BullMQ —
   * an operator pressing "reconcile now" should get an answer, not a job id —
   * so the queue's limiter does not cover it. This is the same primitive the
   * catalog path uses for the same reason, and keeping enforcement in the core
   * is what stops each connector inventing its own throttling (§5).
   */
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
    private readonly registry: ConnectorRegistry,
    private readonly inventory: InventoryService,
    private readonly syncEvents: SyncEventService,
    private readonly outbound: OutboundQueue,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * Reconcile every channel that can be reconciled.
   *
   * Used by the nightly sweep. One channel failing does not stop the rest — a
   * Shopify store with an expired token must not prevent the others being
   * checked — so failures are logged and reported rather than thrown.
   */
  async reconcileAll(options: ReconcileOptions = {}): Promise<ReconcileOutcome[]> {
    const candidates = await this.prisma.channelInstance.findMany({
      where: { enabled: true },
      select: { id: true, connectorKey: true, displayName: true },
      orderBy: { createdAt: 'asc' },
    });

    const outcomes: ReconcileOutcome[] = [];

    for (const channel of candidates) {
      if (!this.canReconcile(channel.connectorKey)) continue;

      try {
        outcomes.push(await this.reconcileChannel(channel.id, options));
      } catch (error) {
        this.logger.error(
          `Reconcile failed for "${channel.displayName}": ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(`Reconciled ${outcomes.length} channel(s)`);
    return outcomes;
  }

  /**
   * Reconcile one channel.
   *
   * Throws on a channel that cannot be reconciled at all — a disabled one, or a
   * connector with no `reconcile` capability. That is a caller error worth
   * surfacing, not a silent no-op: the operator pressed a button.
   */
  async reconcileChannel(
    channelInstanceId: string,
    options: ReconcileOptions = {},
  ): Promise<ReconcileOutcome> {
    const { connector, ctx, displayName, enabled } = await this.channels.resolve(channelInstanceId);

    if (!hasCapability(connector.capabilities, 'reconcile')) {
      // A file-based channel lands here. Its data is only as current as the
      // last human round trip, so there is nothing to compare against and its
      // staleness must not be read as drift (ADR 0002).
      throw new BadRequestException(
        `"${displayName}" cannot be reconciled: ${connector.displayName} does not report live ` +
          `listing state. Its freshness depends on file uploads instead.`,
      );
    }
    if (!enabled) {
      throw new BadRequestException(`"${displayName}" is disabled.`);
    }

    const started = Date.now();
    const syncEventId = await this.syncEvents.begin({
      direction: 'reconcile',
      channelInstanceId,
      entityType: 'channel',
      entityId: channelInstanceId,
      operation: 'fetchLiveState',
    });

    try {
      const allocations = await this.loadAllocations(channelInstanceId);
      const observed = await this.fetchAll(connector, ctx, allocations);
      const report = diffLiveState(allocations, observed, options);
      const summary = summarize(report);

      const corrected = await this.autoCorrect(channelInstanceId, connector.key, report);

      await this.syncEvents.finish(syncEventId, report.drifts.length > 0 ? 'conflict' : 'ok', {
        detail: summary,
        durationMs: Date.now() - started,
        payload: {
          checked: report.checked,
          // Bounded. A first run against a channel we have never pushed to
          // differs on every row, and the audit log is not the place for
          // thousands of them.
          drifts: report.drifts.slice(0, 200),
          driftCount: report.drifts.length,
          pending: report.pending.slice(0, 200),
          pendingCount: report.pending.length,
          unmanaged: report.unmanaged.slice(0, 200),
          unmanagedCount: report.unmanaged.length,
          corrected,
        },
      });

      await this.refreshAlert(channelInstanceId, displayName, report, corrected);

      await this.prisma.channelInstance.update({
        where: { id: channelInstanceId },
        data: { lastReconciledAt: new Date() },
      });

      this.logger.log(`${displayName}: ${summary}`);

      return {
        channelInstanceId,
        channelName: displayName,
        report,
        summary,
        corrected,
        ranAt: new Date(),
      };
    } catch (error) {
      await this.syncEvents.finish(syncEventId, 'error', {
        detail: (error as Error).message,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Asked of the registry rather than by resolving the channel, so the sweep
   * does not decrypt credentials for channels it is about to skip.
   *
   * `supports` answers false for a connector key with nothing registered, which
   * is the right outcome here — that channel is already reported as broken by
   * ChannelsService, and announcing it again is not this job's business.
   */
  private canReconcile(connectorKey: string): boolean {
    return this.registry.supports(connectorKey, 'reconcile');
  }

  /**
   * The allocations worth comparing: those carrying a platform listing id.
   *
   * One that has never been mapped has nothing on the channel to differ from,
   * and counting it as missing would report the same non-finding every night.
   */
  private async loadAllocations(channelInstanceId: string): Promise<ReconcilableAllocation[]> {
    const listings = await this.inventory.listChannelListings(channelInstanceId);

    return listings
      .filter((listing) => listing.externalListingId !== null)
      .map((listing) => ({
        id: listing.allocationId,
        externalListingId: listing.externalListingId!,
        listedQuantity: listing.listedQuantity,
        desiredListedQuantity: listing.quantity,
        price: listing.price,
        currency: listing.currency,
        status: listing.status,
      }));
  }

  /**
   * Ask the connector about every listing, in batches and at its declared rate.
   *
   * A partial answer is normal: connectors are required to omit ids they cannot
   * find rather than inventing a zero, and the diff treats an omission as
   * "no answer" rather than "quantity 0".
   */
  private async fetchAll(
    connector: Connector,
    ctx: Ctx,
    allocations: readonly ReconcilableAllocation[],
  ): Promise<ObservedListing[]> {
    const ids = allocations.map((a) => a.externalListingId);
    const observed: ObservedListing[] = [];
    const gap = intervalFor(connector.rateLimit);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const states = await this.limiter.run(connector.key, gap, () =>
        connector.fetchLiveState!(ctx, batch),
      );
      observed.push(...states);
    }

    return observed;
  }

  /**
   * Re-push our quantity where the channel disagrees, if the operator opted in.
   *
   * Queues the same job an ordinary edit would, so the push goes through the
   * one worker that knows how to talk to the channel and re-reads the current
   * value when it runs. Reconciliation therefore corrects towards what the
   * ledger says *now*, not towards the stale number it just compared against.
   */
  private async autoCorrect(
    channelInstanceId: string,
    connectorKey: string,
    report: ReconcileReport,
  ): Promise<number> {
    const channel = await this.prisma.channelInstance.findUnique({
      where: { id: channelInstanceId },
      select: { reconcileAutoCorrect: true },
    });

    if (!channel?.reconcileAutoCorrect) return 0;

    const correctable = correctableDrifts(report.drifts);

    for (const drift of correctable) {
      try {
        await this.outbound.enqueue(connectorKey, {
          channelInstanceId,
          allocationId: drift.allocationId,
          operation: 'quantity',
        });
      } catch (error) {
        // Best-effort, like the fan-out on a sale. The finding is already
        // recorded and alerted; failing the whole run because Redis blinked
        // would lose the report too.
        this.logger.error(
          `Could not queue correction for allocation ${drift.allocationId}: ${(error as Error).message}`,
        );
      }
    }

    return correctable.length;
  }

  /**
   * Keep exactly one open drift alert per channel, and clear it when a run
   * comes back clean.
   *
   * Alerts are flags, not tallies. One per drifting listing would put hundreds
   * in the inbox after a single bad night and train the operator to ignore all
   * of them — which is the one outcome alerting cannot survive. The per-listing
   * detail is in the SyncEvent payload, where it belongs.
   *
   * Only alerts this sweep raised are touched. The inbound worker also files
   * `reconcile_drift` for a sale against an unmapped listing, and that is a
   * different fact about a different moment; closing it here because the
   * quantities happen to line up now would discard it.
   */
  private async refreshAlert(
    channelInstanceId: string,
    channelName: string,
    report: ReconcileReport,
    corrected: number,
  ): Promise<void> {
    if (report.drifts.length === 0) {
      // Self-clearing. A flag that stays raised after the problem is gone is a
      // flag nobody trusts.
      await this.alerts.clearFlag('reconcile_drift', channelInstanceId, ALERT_SOURCE);
      return;
    }

    const detail =
      `${summarize(report)}` +
      (corrected > 0 ? ` Re-pushed ${corrected} of them.` : '') +
      (report.unmanaged.length > 0
        ? ` ${report.unmanaged.length} listing(s) on the channel are not managed here.`
        : '');

    const title = `${channelName} differs on ${report.drifts.length} listing${
      report.drifts.length === 1 ? '' : 's'
    }`;

    await this.alerts.raiseFlag({
      kind: 'reconcile_drift',
      source: ALERT_SOURCE,
      // Warning, not critical. Drift means the two sides disagree, which is
      // worth a human's attention but is not the active harm an oversell is.
      severity: 'warning',
      channelInstanceId,
      title,
      detail,
      context: {
        driftCount: report.drifts.length,
        corrected,
        // Enough to act on without opening the sync log, but not the whole run.
        examples: report.drifts.slice(0, 20),
      },
    });
  }
}
