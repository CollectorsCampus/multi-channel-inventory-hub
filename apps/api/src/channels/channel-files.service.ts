import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { encodeJson } from '@hub/db';
import {
  hasCapability,
  type Connector,
  type Ctx,
  type ExportedFile,
  type ImportProblem,
} from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { InventoryService } from '../inventory/inventory.service';
import { SyncEventService } from '../sync/sync-event.service';
import { InboundQueue } from '../queue/inbound-queue.service';
import { FILE_TOPIC_PREFIX, type ImportKind, type ImportSummary } from './file-transport';

/**
 * File transport for manual channels (ADR 0002).
 *
 * A channel with no usable API still has a sync loop; a human is the transport.
 * The operator downloads a file here, uploads it to the platform, and later
 * uploads the platform's own export back. This service is both ends of that
 * round trip.
 *
 * **Order imports do not touch the ledger here.** The uploaded file is stored
 * and queued, and the existing inbound worker applies it — the same path a
 * Shopify webhook takes. That is not tidiness: per-sale idempotency, allocation
 * lookup, oversell alerting and the audit log all live on that path already,
 * and a second implementation of them for files would be a second set of bugs.
 * What the operator gets back synchronously is the *parse* result, which is the
 * part they can actually act on.
 *
 * **Inventory imports are read-only.** There is nowhere for live listing state
 * to go until reconciliation exists (Phase 5), so the upload reports what the
 * platform believes and compares it against what we believe, without writing
 * either. Quietly adjusting the ledger from a file would be reconciliation
 * implemented by accident, with no drift policy and no alerting behind it.
 */

@Injectable()
export class ChannelFilesService {
  private readonly logger = new Logger(ChannelFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
    private readonly inventory: InventoryService,
    private readonly syncEvents: SyncEventService,
    private readonly inbound: InboundQueue,
  ) {}

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * Render this channel's listings to a file for the operator to upload.
   *
   * `unmapped` is returned alongside the file rather than left in a log. An
   * allocation with no external listing id cannot be exported — there is
   * nothing for the platform to match it against, and matching by name would be
   * a guess about which printing the seller meant — so the operator needs to
   * know how much of their inventory the file does not cover. Counting it here
   * rather than asking the connector keeps the SDK contract as "return a file"
   * instead of "return a file and a report".
   */
  async exportListings(
    channelInstanceId: string,
  ): Promise<{ file: ExportedFile; total: number; unmapped: number }> {
    const { connector, ctx } = await this.channels.resolve(channelInstanceId);

    if (!hasCapability(connector.capabilities, 'listing.export')) {
      throw new BadRequestException(
        `"${connector.displayName}" does not produce file exports. It syncs over its own API.`,
      );
    }

    const listings = await this.inventory.listChannelListings(channelInstanceId);
    const unmapped = listings.filter((listing) => !listing.externalListingId).length;
    const started = Date.now();

    const file = await connector.exportListings!(ctx, { listings });

    await this.syncEvents.record({
      direction: 'outbound',
      channelInstanceId,
      entityType: 'channel',
      entityId: channelInstanceId,
      operation: 'exportListings',
      outcome: 'ok',
      durationMs: Date.now() - started,
      payload: { filename: file.filename, listings: listings.length, unmapped },
    });

    return { file, total: listings.length, unmapped };
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  async importFile(
    channelInstanceId: string,
    kind: ImportKind,
    file: { filename: string; content: Buffer },
  ): Promise<ImportSummary> {
    if (file.content.length === 0) {
      throw new BadRequestException('The uploaded file is empty.');
    }

    const { connector, ctx } = await this.channels.resolve(channelInstanceId);
    const capability = kind === 'orders' ? 'orders.import' : 'inventory.import';

    if (!hasCapability(connector.capabilities, capability)) {
      throw new BadRequestException(
        `"${connector.displayName}" does not accept ${kind} file imports.`,
      );
    }

    return kind === 'orders'
      ? this.importOrders(channelInstanceId, connector, ctx, file)
      : this.importInventory(channelInstanceId, connector, ctx, file);
  }

  /**
   * Parse a sales export, store it, and hand it to the inbound worker.
   *
   * Parsing here is validation, not the authoritative pass — the worker parses
   * the stored bytes again when it runs. Doing it twice costs microseconds and
   * buys the operator an immediate answer about whether they uploaded the right
   * file, which is the mistake they will actually make.
   */
  private async importOrders(
    channelInstanceId: string,
    connector: Connector,
    ctx: Ctx,
    file: { filename: string; content: Buffer },
  ): Promise<ImportSummary> {
    const parsed = await connector.importOrders!(ctx, file);

    // Nothing usable came out. Storing and queueing it would give the worker
    // nothing to do and the operator a false sense that it worked.
    if (parsed.records.length === 0) {
      await this.syncEvents.record({
        direction: 'inbound',
        channelInstanceId,
        entityType: 'order',
        operation: 'importOrders',
        outcome: 'error',
        detail: parsed.problems[0]?.message ?? 'No sales were found in this file.',
        payload: { filename: file.filename, problems: parsed.problems.slice(0, 50) },
      });

      return {
        kind: 'orders',
        filename: file.filename,
        recordCount: 0,
        problems: parsed.problems.length > 0 ? parsed.problems : [NOTHING_FOUND],
        duplicate: false,
        queued: false,
      };
    }

    // Idempotency for the *upload*, byte-exact. Per-sale keys come from the
    // connector and are what actually stop a double decrement; this only avoids
    // re-queueing work already in flight.
    const externalEventId = createHash('sha256').update(file.content).digest('hex');

    const existing = await this.prisma.webhookEvent.findUnique({
      where: { channelInstanceId_externalEventId: { channelInstanceId, externalEventId } },
      select: { id: true, status: true },
    });

    if (existing && existing.status !== 'failed') {
      this.logger.log(`Ignoring re-upload of an identical file for channel ${channelInstanceId}`);
      return {
        kind: 'orders',
        filename: file.filename,
        recordCount: parsed.records.length,
        problems: parsed.problems,
        duplicate: true,
        queued: false,
      };
    }

    // A previous attempt failed. The operator re-uploading is how they retry,
    // so reuse the row and queue it again rather than telling them it is a
    // duplicate and leaving it stuck.
    const eventId =
      existing?.id ??
      (
        await this.prisma.webhookEvent.create({
          data: {
            channelInstanceId,
            topic: `${FILE_TOPIC_PREFIX}orders`,
            externalEventId,
            headers: encodeJson({ filename: file.filename, kind: 'orders' }),
            body: file.content.toString('utf8'),
            status: 'received',
          },
          select: { id: true },
        })
      ).id;

    if (existing) {
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: 'received', error: null },
      });
    }

    await this.inbound.enqueue(eventId);

    return {
      kind: 'orders',
      filename: file.filename,
      recordCount: parsed.records.length,
      problems: parsed.problems,
      duplicate: false,
      queued: true,
    };
  }

  /**
   * Parse an inventory export and report it against what we believe.
   *
   * Writes nothing to the ledger. Until reconciliation exists there is no
   * policy for what a difference *means* — a platform quantity below ours could
   * be a sale we missed, a manual edit on the platform, or stock we never
   * pushed — and picking one silently is how a file import becomes an
   * unexplained stock adjustment.
   */
  private async importInventory(
    channelInstanceId: string,
    connector: Connector,
    ctx: Ctx,
    file: { filename: string; content: Buffer },
  ): Promise<ImportSummary> {
    const started = Date.now();
    const parsed = await connector.importInventory!(ctx, file);

    const allocations = await this.prisma.channelAllocation.findMany({
      where: { channelInstanceId, externalListingId: { not: null } },
      select: { externalListingId: true, listedQuantity: true },
    });

    const believed = new Map(
      allocations.map((a) => [a.externalListingId!, a.listedQuantity] as const),
    );

    const differences: NonNullable<ImportSummary['differences']> = [];
    let unmapped = 0;

    for (const state of parsed.records) {
      const ours = believed.get(state.externalListingId);
      if (ours === undefined) {
        // The platform lists something we do not manage. Normal — sellers list
        // outside the hub — and not a difference, because we have no belief
        // about it to differ from.
        unmapped++;
        continue;
      }
      if (ours !== state.quantity) {
        differences.push({
          externalListingId: state.externalListingId,
          platformQuantity: state.quantity,
          believedQuantity: ours,
        });
      }
    }

    await this.syncEvents.record({
      direction: 'reconcile',
      channelInstanceId,
      entityType: 'inventory',
      entityId: channelInstanceId,
      operation: 'importInventory',
      outcome: parsed.records.length === 0 ? 'error' : 'ok',
      durationMs: Date.now() - started,
      detail:
        parsed.records.length === 0
          ? (parsed.problems[0]?.message ?? 'No listings were found in this file.')
          : `Read ${parsed.records.length} listing(s); ${differences.length} differ from our records.`,
      payload: {
        filename: file.filename,
        listings: parsed.records.length,
        unmapped,
        // Bounded: a first sync against a channel we have never pushed to
        // differs on every row, and the audit log is not the place for a
        // thousand of them.
        differences: differences.slice(0, 100),
        problems: parsed.problems.slice(0, 50),
      },
    });

    // A channel's freshness is what this timestamp means, and a manual channel
    // has no other way to set it.
    await this.prisma.channelInstance.update({
      where: { id: channelInstanceId },
      data: { lastReconciledAt: new Date() },
    });

    return {
      kind: 'inventory',
      filename: file.filename,
      recordCount: parsed.records.length,
      problems:
        parsed.records.length === 0 && parsed.problems.length === 0
          ? [NOTHING_FOUND]
          : parsed.problems,
      duplicate: false,
      queued: false,
      differences,
      unmappedCount: unmapped,
    };
  }
}

const NOTHING_FOUND: ImportProblem = {
  message: 'Nothing usable was found in this file.',
};
