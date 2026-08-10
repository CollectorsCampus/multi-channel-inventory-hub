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
import { hasCapability, type Capability, type Connector, type Ctx } from '@hub/connector-sdk';
import { REDIS_CONNECTION } from '../queue/redis.provider';
import { outboundQueueName, type OutboundJob } from '../queue/outbound-queue.service';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { itemKind } from '../channels/listing-defaults';
import { SyncEventService } from './sync-event.service';
import { AlertsService } from './alerts.service';

/** Distinguishes this worker's `sync_failure` flag from any other source's. */
const PUSH_FAILURE_SOURCE = 'outbound:push-failure';

/**
 * Performs outbound pushes (§6).
 *
 * One worker per connector key, mirroring the queues, so a connector's declared
 * rate limit is enforced by BullMQ's limiter rather than trusted to the
 * connector (§5).
 *
 * The worker re-reads the allocation when it runs. Jobs carry only *what*
 * changed, never the value, so a retry landing after a newer change still
 * writes current state — and out-of-order delivery is normal once retries and
 * backoff exist.
 */

/** Maps an operation to the capability that must be declared to perform it. */
const REQUIRED_CAPABILITY: Record<OutboundJob['operation'], Capability> = {
  quantity: 'listing.quantity',
  price: 'listing.price',
  listing: 'listing.push',
  delist: 'listing.delist',
};

@Injectable()
export class OutboundWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundWorker.name);
  private readonly workers: Worker<OutboundJob>[] = [];

  constructor(
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    private readonly config: ConfigService,
    private readonly registry: ConnectorRegistry,
    private readonly channels: ChannelContextFactory,
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
    private readonly syncEvents: SyncEventService,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    // 12-factor deployments may run workers as a separate process (§9); the web
    // tier then sets this false and only enqueues.
    if (!this.config.get<boolean>('RUN_WORKERS_IN_PROCESS')) {
      this.logger.log('Workers disabled in this process (RUN_WORKERS_IN_PROCESS=false)');
      return;
    }

    for (const summary of this.registry.list()) {
      const connector = this.registry.get(summary.key);
      const limit = connector.rateLimit;

      const worker = new Worker<OutboundJob>(
        outboundQueueName(summary.key),
        (job) => this.process(job),
        {
          connection: this.connection,
          concurrency: 5,
          // The core enforces the connector's declared limit, so every
          // connector is throttled identically and none can forget to be.
          ...(limit ? { limiter: { max: limit.requestsPerSecond, duration: 1000 } } : {}),
        },
      );

      worker.on('failed', (job, error) => {
        this.logger.warn(
          `Push ${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? 0}): ${error.message}`,
        );
      });

      this.workers.push(worker);
      this.logger.log(
        `Outbound worker listening on ${outboundQueueName(summary.key)}` +
          (limit ? ` at ${limit.requestsPerSecond}/s` : ''),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }

  private async process(job: Job<OutboundJob>): Promise<void> {
    const { channelInstanceId, allocationId, operation } = job.data;
    const started = Date.now();

    const allocation = await this.prisma.channelAllocation.findUnique({
      where: { id: allocationId },
    });

    // The allocation was removed after the job was queued. Nothing to push, and
    // retrying will never help.
    if (!allocation) {
      throw new UnrecoverableError(`Allocation ${allocationId} no longer exists.`);
    }

    const { connector, ctx, enabled } = await this.channels.resolve(channelInstanceId);

    // A disabled channel should stop receiving pushes without failing loudly
    // forever; the operator turned it off deliberately.
    if (!enabled) {
      this.logger.debug(`Channel ${channelInstanceId} is disabled; skipping ${operation}.`);
      return;
    }

    const capability = REQUIRED_CAPABILITY[operation];
    if (!hasCapability(connector.capabilities, capability)) {
      // Capabilities are declared so the core can degrade gracefully (§5).
      // Reaching here means something queued work the channel cannot do, which
      // no amount of retrying fixes.
      throw new UnrecoverableError(`Connector "${connector.key}" does not support ${capability}.`);
    }

    const syncEventId = await this.syncEvents.begin({
      direction: 'outbound',
      channelInstanceId,
      entityType: 'allocation',
      entityId: allocationId,
      operation,
    });

    try {
      // Re-read now, not at enqueue time. This is what makes a late retry
      // write current state instead of a stale value.
      const ledger = await this.inventory.getLedger(allocation.inventoryItemId);
      const current = ledger.allocations.find((a) => a.id === allocationId);
      if (!current) {
        throw new UnrecoverableError(`Allocation ${allocationId} vanished mid-push.`);
      }

      const result = await this.dispatch(connector, ctx, operation, current);

      // Only now does the cached belief about the channel become true.
      await this.prisma.channelAllocation.update({
        where: { id: allocationId },
        data: {
          listedQuantity: current.desiredListedQuantity,
          status: operation === 'delist' ? 'delisted' : 'listed',
          lastPushedAt: new Date(),
          lastError: null,
          ...(result?.externalListingId ? { externalListingId: result.externalListingId } : {}),
        },
      });

      await this.syncEvents.finish(syncEventId, 'ok', {
        durationMs: Date.now() - started,
        payload: { quantity: current.desiredListedQuantity, price: current.price },
      });

      // After the push is recorded, never before: the sellout policy reacts to
      // a quantity the channel now actually shows. Its own failure must not
      // fail this job — the push succeeded, and retrying it would re-push a
      // quantity that already landed.
      if (operation === 'quantity' && current.desiredListedQuantity === 0) {
        await this.maybeDraftAtSellout(connector, ctx, channelInstanceId, allocation, current);
      }
    } catch (error) {
      const message = (error as Error).message;
      const terminal = error instanceof UnrecoverableError || isLastAttempt(job);

      await this.syncEvents.finish(syncEventId, 'error', {
        detail: message,
        durationMs: Date.now() - started,
      });

      // §6: terminal failures mark the allocation and raise an alert. Marking
      // on every attempt would flag a listing that a retry is about to fix.
      if (terminal) {
        await this.markFailed(allocationId, channelInstanceId, operation, message);
      }

      throw error;
    }
  }

  private async dispatch(
    connector: Connector,
    ctx: Ctx,
    operation: OutboundJob['operation'],
    allocation: {
      id: string;
      externalListingId: string | null;
      desiredListedQuantity: number;
      price: number | null;
      currency: string;
    },
    // Explicit: only `listing` will ever return an id, once pushListing is
    // wired up. Without this TypeScript narrows the union away to `never`.
  ): Promise<{ externalListingId: string } | null> {
    const ref = { allocationId: allocation.id, externalListingId: allocation.externalListingId };

    switch (operation) {
      case 'quantity':
        await connector.updateQuantity!(ctx, {
          ...ref,
          quantity: allocation.desiredListedQuantity,
        });
        return null;

      case 'price':
        if (allocation.price === null) {
          throw new UnrecoverableError('Cannot push a price for an allocation with none set.');
        }
        await connector.updatePrice!(ctx, {
          ...ref,
          price: allocation.price,
          currency: allocation.currency,
        });
        return null;

      case 'delist':
        await connector.delist!(ctx, ref);
        return null;

      case 'listing':
        // pushListing needs SKU detail the allocation alone does not carry.
        // Deferred until the channel-configuration UI exists to create
        // listings; quantity and price cover an already-mapped variant.
        throw new UnrecoverableError('listing.push is not wired up yet.');
    }
  }

  /**
   * The sellout policy (opt-in per channel): a single whose advertised
   * quantity just went to zero has its product drafted, so customers stop
   * finding an unbuyable page.
   *
   * Three gates before the channel is touched, cheapest first: the channel
   * must have opted in, the connector must be able to do it, and the item must
   * be a **single** — a sealed listing was created and imaged by the operator,
   * and its visibility is theirs. The connector then enforces the fourth gate
   * against the platform's own numbers (`onlyIfSoldOut`), so a product with an
   * in-stock sibling variant — or stock at a location the hub does not manage
   * — is left alone.
   *
   * **One direction only.** A restock never re-activates the product: nothing
   * should become buyable on a storefront because a background job ran. The
   * operator activates by hand, exactly as they do for a newly created draft.
   *
   * Failures are logged and swallowed: the quantity push already succeeded and
   * is recorded, and failing the job now would retry a push that landed.
   */
  private async maybeDraftAtSellout(
    connector: Connector,
    ctx: Ctx,
    channelInstanceId: string,
    allocation: { inventoryItemId: string },
    current: { externalListingId: string | null },
  ): Promise<void> {
    if (!current.externalListingId) return;
    if (!hasCapability(connector.capabilities, 'listing.status')) return;

    try {
      const channel = await this.prisma.channelInstance.findUnique({
        where: { id: channelInstanceId },
        select: { draftAtSellout: true },
      });
      if (!channel?.draftAtSellout) return;

      const item = await this.prisma.inventoryItem.findUnique({
        where: { id: allocation.inventoryItemId },
        select: { sku: { select: { condition: true } } },
      });
      if (!item || itemKind(item.sku.condition) !== 'single') return;

      const result = await connector.updateListingStatus!(ctx, {
        externalListingId: current.externalListingId,
        status: 'draft',
        onlyIfSoldOut: true,
      });

      this.logger.log(
        result.changed
          ? `Drafted sold-out listing ${current.externalListingId} on ${channelInstanceId}.`
          : `Sellout draft skipped for ${current.externalListingId}: ${result.reason ?? 'no change'}.`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not draft sold-out listing ${current.externalListingId}: ${(error as Error).message}`,
      );
    }
  }

  private async markFailed(
    allocationId: string,
    channelInstanceId: string,
    operation: string,
    message: string,
  ): Promise<void> {
    await this.prisma.channelAllocation.update({
      where: { id: allocationId },
      data: { status: 'error', lastError: message.slice(0, 1000) },
    });

    // One open alert per channel, not one per failed push.
    //
    // A channel with a bad token fails every push, and an alert each time
    // would bury everything else and train an operator to ignore the inbox —
    // which is the one outcome alerting cannot survive. Every individual
    // failure is already in the sync log with its own detail; the alert only
    // has to say "this channel is broken", and be refreshed with the latest
    // reason while it stays broken.
    await this.alerts.raiseFlag({
      kind: 'sync_failure',
      source: PUSH_FAILURE_SOURCE,
      severity: 'warning',
      channelInstanceId,
      title: `Could not push ${operation} to the channel`,
      // The count is what distinguishes "one bad push" from "this channel has
      // been failing all night", which the previous refresh-in-place lost.
      detail: (n) =>
        message.slice(0, 2000) + (n > 1 ? ` (${n} consecutive failures on this channel.)` : ''),
    });
  }
}

/** True when BullMQ will not try again. */
function isLastAttempt(job: Job): boolean {
  const attempts = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= attempts;
}
