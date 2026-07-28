import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Connector, Ctx, NormalizedEvent, SaleEvent } from '@hub/connector-sdk';
import { decodeJsonObject } from '@hub/db';
import { REDIS_CONNECTION } from '../queue/redis.provider';
import { INBOUND_QUEUE, type InboundJob } from '../queue/outbound-queue.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { fileTopicKind, isFileTopic } from '../channels/file-transport';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SyncEventService } from './sync-event.service';

/**
 * Processes inbound platform events (§6).
 *
 * This is where a sale on a channel becomes a decrement of the ledger, and then
 * a fan-out to every other channel whose advertised quantity moved. Everything
 * the ingress endpoint deliberately did not do happens here.
 *
 * The quantity maths is entirely InventoryService's; this worker only decides
 * *which* allocation an event refers to and records what happened.
 */
@Injectable()
export class InboundWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundWorker.name);
  private worker?: Worker<InboundJob>;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    private readonly config: ConfigService,
    private readonly channels: ChannelContextFactory,
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
    private readonly syncEvents: SyncEventService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('RUN_WORKERS_IN_PROCESS')) return;

    this.worker = new Worker<InboundJob>(INBOUND_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      // Deliberately modest. Sales for one SKU arriving together contend on the
      // same optimistic-locking token, and higher concurrency mostly buys
      // retries (ADR 0001 §1).
      concurrency: 3,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.warn(`Inbound job ${job?.id ?? '?'} failed: ${error.message}`);
    });

    this.logger.log(`Inbound worker listening on ${INBOUND_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<InboundJob>): Promise<void> {
    const record = await this.prisma.webhookEvent.findUnique({
      where: { id: job.data.webhookEventId },
    });

    if (!record) {
      throw new UnrecoverableError(`Webhook event ${job.data.webhookEventId} no longer exists.`);
    }

    // Already handled — a redelivery that slipped past the ingress dedupe, or a
    // job replayed after the row was completed.
    if (record.status === 'processed') return;

    const { connector, ctx } = await this.channels.resolve(record.channelInstanceId);
    const body = Buffer.from(record.body, 'utf8');

    // Two things arrive on this queue: a platform's webhook, and a file an
    // operator uploaded for a channel with no API (ADR 0002). They differ only
    // in how the bytes reached us, so everything past this point — idempotency,
    // allocation lookup, oversell alerting — is shared rather than reimplemented
    // for files.
    let events: NormalizedEvent[];
    try {
      events = isFileTopic(record.topic)
        ? await this.parseUploadedFile(connector, ctx, record, body)
        : this.parseWebhookBody(connector, ctx, body);
    } catch (error) {
      // A payload we cannot parse will never parse. Retrying wastes attempts
      // and delays the queue behind it.
      await this.markEvent(record.id, 'failed', (error as Error).message);
      throw new UnrecoverableError(`Could not parse inbound event: ${(error as Error).message}`);
    }

    for (const event of events) {
      if (event.type === 'sale') {
        await this.applySale(record.channelInstanceId, event);
      }
      // listing_removed is recorded by the connector but not acted on yet:
      // deciding whether a delisting on the channel should change our ledger is
      // a reconciliation question (§6), not a sale.
    }

    await this.markEvent(record.id, 'processed');
  }

  private parseWebhookBody(connector: Connector, ctx: Ctx, body: Buffer): NormalizedEvent[] {
    if (typeof connector.parseWebhook !== 'function') {
      throw new UnrecoverableError(`Connector "${connector.key}" cannot parse webhooks.`);
    }
    return connector.parseWebhook(ctx, body);
  }

  /**
   * Re-parse an uploaded sales export at execution time.
   *
   * The upload endpoint already parsed this file to answer the operator, and
   * this pass is the authoritative one — same reason the outbound worker
   * re-reads its allocation instead of trusting the job payload. Parsing is
   * pure, so the two agree; storing the parsed events instead would put a
   * connector's output in the queue and lose the raw bytes that make a bad
   * import diagnosable.
   *
   * Row-level problems are not raised here. They were reported synchronously to
   * the operator who uploaded the file, and repeating them per retry would fill
   * the activity log with the same complaint.
   */
  private async parseUploadedFile(
    connector: Connector,
    ctx: Ctx,
    record: { topic: string | null; headers: string },
    body: Buffer,
  ): Promise<NormalizedEvent[]> {
    const kind = fileTopicKind(record.topic);

    // Only sales move the ledger. An inventory export is reported at upload
    // time and never queued, because there is nowhere for live listing state to
    // go until reconciliation exists (Phase 5).
    if (kind !== 'orders') {
      throw new UnrecoverableError(`No inbound handler for uploaded file kind "${kind}".`);
    }
    if (typeof connector.importOrders !== 'function') {
      throw new UnrecoverableError(`Connector "${connector.key}" cannot import order files.`);
    }

    const filename = decodeJsonObject(record.headers).filename;

    const result = await connector.importOrders(ctx, {
      filename: typeof filename === 'string' ? filename : 'upload.csv',
      content: body,
    });

    return result.records;
  }

  /**
   * Apply one sale.
   *
   * Two things can go wrong that are not errors: the listing may not map to an
   * allocation we know about, and the sale may already have been applied. Both
   * are recorded and skipped rather than retried.
   */
  private async applySale(channelInstanceId: string, event: SaleEvent): Promise<void> {
    // Per-sale idempotency, distinct from the delivery-level dedupe at ingress.
    // A platform can report the same line in two different payloads — an order
    // creation and a later update — which are not byte-identical.
    const alreadyApplied = await this.prisma.syncEvent.findFirst({
      where: {
        direction: 'inbound',
        entityType: 'order',
        entityId: event.externalEventId,
        outcome: 'ok',
      },
      select: { id: true },
    });

    if (alreadyApplied) {
      this.logger.debug(`Sale ${event.externalEventId} already applied; skipping.`);
      return;
    }

    const allocation = await this.prisma.channelAllocation.findFirst({
      where: { channelInstanceId, externalListingId: event.externalListingId },
    });

    if (!allocation) {
      // Something sold on the channel that the hub does not manage. Not an
      // error — sellers list things outside the hub — but the operator should
      // know, because it means the ledger and the channel disagree about what
      // exists.
      await this.syncEvents.record({
        direction: 'inbound',
        channelInstanceId,
        entityType: 'order',
        entityId: event.externalEventId,
        operation: 'sale',
        outcome: 'conflict',
        detail: `No allocation maps to listing ${event.externalListingId}.`,
        payload: event,
      });

      await this.prisma.alert.create({
        data: {
          kind: 'reconcile_drift',
          severity: 'info',
          channelInstanceId,
          title: 'Sale for an unmapped listing',
          detail:
            `A sale arrived for listing ${event.externalListingId}, which is not linked to ` +
            `any inventory item. Stock was not adjusted.`,
          status: 'open',
        },
      });
      return;
    }

    const syncEventId = await this.syncEvents.begin({
      direction: 'inbound',
      channelInstanceId,
      entityType: 'order',
      entityId: event.externalEventId,
      operation: 'sale',
      payload: event,
    });

    const started = Date.now();

    try {
      const outcome = await this.inventory.applySaleFromChannel(
        allocation.inventoryItemId,
        allocation.id,
        event.quantity,
        { orderReference: event.orderReference },
      );

      // §6 step 3 — the fan-out to every channel whose listed value moved — is
      // already done: InventoryService queues those pushes itself, for sales
      // and operator edits alike. Duplicating it here would double-queue and
      // put the rule in two places.
      await this.raiseConflictAlerts(channelInstanceId, allocation.id, outcome.conflicts);

      await this.syncEvents.finish(syncEventId, outcome.conflicts.length > 0 ? 'conflict' : 'ok', {
        durationMs: Date.now() - started,
        payload: {
          quantityOnHand: outcome.ledger.quantityOnHand,
          changes: outcome.changes,
          conflicts: outcome.conflicts,
        },
      });
    } catch (error) {
      await this.syncEvents.finish(syncEventId, 'error', {
        detail: (error as Error).message,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  /**
   * Turn clamps and reclamations into alerts a human will see.
   *
   * §6 is explicit that an oversell is never resolved automatically — we do not
   * cancel orders — so the only correct response is to tell someone.
   */
  private async raiseConflictAlerts(
    channelInstanceId: string,
    allocationId: string,
    conflicts: Array<{ code: string; message: string; shortfall: number }>,
  ): Promise<void> {
    for (const conflict of conflicts) {
      const oversell = conflict.code.startsWith('oversell');

      await this.prisma.alert.create({
        data: {
          kind: oversell ? 'oversell' : 'invariant_violation',
          severity: oversell ? 'critical' : 'warning',
          channelInstanceId,
          title: oversell
            ? `Oversold by ${conflict.shortfall}`
            : 'Committed stock reduced to match reality',
          detail: conflict.message,
          context: JSON.stringify({ allocationId, ...conflict }),
          status: 'open',
        },
      });
    }
  }

  private async markEvent(id: string, status: string, error?: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        status,
        processedAt: new Date(),
        attempts: { increment: 1 },
        error: error?.slice(0, 2000) ?? null,
      },
    });
  }
}
