import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Connector, Ctx } from '@hub/connector-sdk';
import {
  OutboundQueue,
  outboundQueueName,
  type OutboundJob,
} from '../queue/outbound-queue.service';
import { InventoryService } from '../inventory/inventory.service';
import { SyncEventService } from './sync-event.service';
import { AlertsService } from './alerts.service';
import { SelloutService } from './sellout.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The outbound round trip: an allocation change becomes a queued job, a worker
 * picks it up, calls the connector, and the ledger records what happened.
 *
 * Uses a real Redis and a real database, because the properties worth proving
 * are about the seams: that a job is queued at all, that a burst collapses to
 * one, and that the connector receives the *current* quantity rather than the
 * one that was current when the job was created.
 *
 * Skipped unless both TEST_DATABASE_URL and TEST_REDIS_URL are set.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const describeQueue = dbUrl && redisUrl ? describe : describe.skip;

let prisma: PrismaClient;
let connection: Redis;
let outbound: OutboundQueue;
let inventory: InventoryService;

const CONNECTOR_KEY = 'test-connector';

async function seedChannel() {
  return prisma.channelInstance.create({
    data: { connectorKey: CONNECTOR_KEY, displayName: 'Test Channel', config: '{}' },
  });
}

async function seedItem(quantityOnHand: number) {
  const catalogItem = await prisma.catalogItem.create({
    data: {
      name: `Item ${Math.random().toString(36).slice(2, 8)}`,
      searchName: 'item',
      skus: { create: [{ condition: 'NM', printing: 'NORMAL', language: 'EN' }] },
    },
    include: { skus: true },
  });
  return prisma.inventoryItem.create({
    data: { skuId: catalogItem.skus[0]!.id, quantityOnHand },
  });
}

describeQueue('outbound queue round trip', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    outbound = new OutboundQueue(connection);
    inventory = new InventoryService(prisma as unknown as PrismaService, outbound);
  });

  afterAll(async () => {
    await outbound.onModuleDestroy();
    await connection.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await new Queue(outboundQueueName(CONNECTOR_KEY), { connection }).obliterate({ force: true });
    await prisma.syncEvent.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.channelInstance.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  it('queues a push when an allocation changes', async () => {
    const item = await seedItem(10);
    const channel = await seedChannel();

    await inventory.upsertAllocation(item.id, {
      channelInstanceId: channel.id,
      mode: 'pooled',
      maxQuantity: null,
    });

    const queue = outbound.queueFor(CONNECTOR_KEY);
    const jobs = await queue.getWaiting();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      channelInstanceId: channel.id,
      operation: 'quantity',
    });
  });

  /**
   * The payload deliberately carries no quantity, so a burst of edits collapses
   * to one job and whichever survives reads the latest state.
   */
  it('collapses a burst of edits into a single pending job', async () => {
    const item = await seedItem(10);
    const channel = await seedChannel();

    await inventory.upsertAllocation(item.id, {
      channelInstanceId: channel.id,
      mode: 'pooled',
      maxQuantity: null,
    });
    await inventory.adjustQuantityOnHand(item.id, 5, { reason: 'intake' });
    await inventory.adjustQuantityOnHand(item.id, -2, { reason: 'shrinkage' });

    const counts = await outbound.counts(CONNECTOR_KEY);
    expect(counts.waiting).toBe(1);

    const [job] = await outbound.queueFor(CONNECTOR_KEY).getWaiting();
    expect(job!.data).not.toHaveProperty('quantity');
  });

  /**
   * The other half of collapsing, and the one that was wrong.
   *
   * The job id is fixed per allocation and operation so a burst becomes one
   * job. BullMQ enforces that by refusing `add` for an id it already holds —
   * and a completed job still counts. With completed jobs retained, the first
   * successful push permanently poisoned the id: every later change was
   * accepted, logged as queued, and silently discarded.
   *
   * Reproduced against the live store before it was fixed: a quantity pushed,
   * then reverted, and the revert never left the building. The symptom is a
   * storefront that syncs once and then quietly never again — no error, no
   * failed job, nothing in the alert inbox.
   */
  it('queues again after the previous push completed', async () => {
    const item = await seedItem(10);
    const channel = await seedChannel();

    await inventory.upsertAllocation(item.id, {
      channelInstanceId: channel.id,
      mode: 'pooled',
      maxQuantity: null,
    });

    expect((await outbound.counts(CONNECTOR_KEY)).waiting).toBe(1);

    // Drain it through a real worker, so the job reaches completion exactly as
    // it does in production — which is the state that used to poison the id.
    const drain = new Worker<OutboundJob>(outboundQueueName(CONNECTOR_KEY), async () => {}, {
      connection: connection.duplicate(),
    });
    await new Promise<void>((resolve) => drain.once('completed', () => resolve()));
    await drain.close();

    await inventory.adjustQuantityOnHand(item.id, 5, { reason: 'intake' });

    // Before the fix this was 0: `add` returned the retained completed job and
    // created nothing, while `enqueue` logged "Queued" either way.
    expect((await outbound.counts(CONNECTOR_KEY)).waiting).toBe(1);
  });

  it('does not queue for a disabled channel', async () => {
    const item = await seedItem(10);
    const channel = await prisma.channelInstance.create({
      data: {
        connectorKey: CONNECTOR_KEY,
        displayName: 'Disabled',
        config: '{}',
        enabled: false,
      },
    });

    await inventory.upsertAllocation(item.id, {
      channelInstanceId: channel.id,
      mode: 'pooled',
      maxQuantity: null,
    });

    expect((await outbound.counts(CONNECTOR_KEY)).waiting).toBe(0);
  });

  describe('worker execution', () => {
    let worker: Worker<OutboundJob> | undefined;

    afterEach(async () => {
      await worker?.close();
      worker = undefined;
    });

    /**
     * The heart of it: the connector must be handed the quantity that is
     * current *when the job runs*, not when it was queued. Retries and backoff
     * make out-of-order execution normal.
     */
    it('pushes the quantity current at execution time, not at enqueue time', async () => {
      const item = await seedItem(10);
      const channel = await seedChannel();

      const { ledger } = await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });
      const allocationId = ledger.allocations[0]!.id;

      // The queued job was created when 10 were on hand. Change it before the
      // worker runs.
      await inventory.adjustQuantityOnHand(item.id, -4, { reason: 'sale' });

      const pushed: number[] = [];
      const connector = fakeConnector(async (_ctx, req) => {
        pushed.push(req.quantity);
      });

      await runOneJob(connector, allocationId, channel.id);

      expect(pushed).toEqual([6]);
    });

    it('records an ok sync event and marks the allocation listed', async () => {
      const item = await seedItem(8);
      const channel = await seedChannel();
      const { ledger } = await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });
      const allocationId = ledger.allocations[0]!.id;

      await runOneJob(
        fakeConnector(async () => undefined),
        allocationId,
        channel.id,
      );

      const events = await prisma.syncEvent.findMany({ where: { entityId: allocationId } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        direction: 'outbound',
        outcome: 'ok',
        operation: 'quantity',
      });

      const allocation = await prisma.channelAllocation.findUniqueOrThrow({
        where: { id: allocationId },
      });
      expect(allocation.status).toBe('listed');
      expect(allocation.listedQuantity).toBe(8);
      expect(allocation.lastPushedAt).not.toBeNull();
    });

    it('records an error event and raises an alert when the push fails terminally', async () => {
      const item = await seedItem(3);
      const channel = await seedChannel();
      const { ledger } = await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });
      const allocationId = ledger.allocations[0]!.id;

      await runOneJob(
        fakeConnector(async () => {
          throw new Error('Item not stocked at location');
        }),
        allocationId,
        channel.id,
        { attempts: 1 },
      );

      const events = await prisma.syncEvent.findMany({ where: { entityId: allocationId } });
      expect(events[0]).toMatchObject({ outcome: 'error' });
      expect(events[0]!.detail).toMatch(/not stocked/);

      const allocation = await prisma.channelAllocation.findUniqueOrThrow({
        where: { id: allocationId },
      });
      expect(allocation.status).toBe('error');
      expect(allocation.lastError).toMatch(/not stocked/);

      // §6: terminal failures raise an alert for a human.
      const alerts = await prisma.alert.findMany();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'sync_failure', status: 'open' });
    });

    /**
     * A channel with a bad token fails every push. An alert per failure would
     * bury everything else and train an operator to ignore the inbox — the one
     * outcome alerting cannot survive. Each failure is still logged
     * individually; the alert only says "this channel is broken".
     */
    it('keeps one open alert per channel however many pushes fail', async () => {
      const item = await seedItem(5);
      const channel = await seedChannel();
      const { ledger } = await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });
      const allocationId = ledger.allocations[0]!.id;

      const failing = fakeConnector(async () => {
        throw new Error('401 Unauthorized');
      });

      await runOneJob(failing, allocationId, channel.id, { attempts: 1 });
      await runOneJob(failing, allocationId, channel.id, { attempts: 1 });
      await runOneJob(failing, allocationId, channel.id, { attempts: 1 });

      expect(await prisma.alert.count({ where: { kind: 'sync_failure' } })).toBe(1);

      // Every attempt is still individually recorded in the log.
      expect(await prisma.syncEvent.count({ where: { outcome: 'error' } })).toBe(3);
    });

    it('refreshes the open alert with the latest reason', async () => {
      const item = await seedItem(5);
      const channel = await seedChannel();
      const { ledger } = await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
      });
      const allocationId = ledger.allocations[0]!.id;

      await runOneJob(
        fakeConnector(async () => {
          throw new Error('first reason');
        }),
        allocationId,
        channel.id,
        { attempts: 1 },
      );
      await runOneJob(
        fakeConnector(async () => {
          throw new Error('second reason');
        }),
        allocationId,
        channel.id,
        { attempts: 1 },
      );

      const alert = await prisma.alert.findFirstOrThrow({ where: { kind: 'sync_failure' } });
      expect(alert.detail).toMatch(/second reason/);
    });
  });

  /**
   * The sellout policy: a single pushed to zero has its product drafted, per
   * channel opt-in. What is worth pinning is the boundary — the flag, the
   * kind, the direction — and that the policy's own failure never fails a
   * push that already landed.
   */
  describe('draft at sellout', () => {
    function statusConnector(calls: unknown[], options: { fail?: boolean } = {}): Connector {
      return {
        ...fakeConnector(async () => {}),
        capabilities: ['listing.quantity', 'listing.status'],
        updateListingStatus: (async (_ctx: unknown, req: unknown) => {
          if (options.fail) throw new Error('status write refused');
          calls.push(req);
          return { changed: true };
        }) as Connector['updateListingStatus'],
      };
    }

    async function seedLinked(quantityOnHand: number, condition = 'NM') {
      const catalogItem = await prisma.catalogItem.create({
        data: {
          name: `Item ${Math.random().toString(36).slice(2, 8)}`,
          searchName: 'item',
          skus: { create: [{ condition, printing: 'NORMAL', language: 'EN' }] },
        },
        include: { skus: true },
      });
      const item = await prisma.inventoryItem.create({
        data: { skuId: catalogItem.skus[0]!.id, quantityOnHand },
      });
      const channel = await prisma.channelInstance.create({
        data: {
          connectorKey: CONNECTOR_KEY,
          displayName: 'Test Channel',
          config: '{}',
          draftAtSellout: true,
        },
      });
      await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
        externalListingId: 'gid://shopify/ProductVariant/900',
      });
      const allocation = await prisma.channelAllocation.findFirstOrThrow({
        where: { inventoryItemId: item.id, channelInstanceId: channel.id },
      });
      return { channel, allocationId: allocation.id };
    }

    it('asks the connector to draft, guarded, when a single is pushed to zero', async () => {
      const calls: unknown[] = [];
      const { channel, allocationId } = await seedLinked(0);

      await runOneJob(statusConnector(calls), allocationId, channel.id);

      expect(calls).toEqual([
        {
          externalListingId: 'gid://shopify/ProductVariant/900',
          status: 'draft',
          onlyIfSoldOut: true,
        },
      ]);
    });

    it('does nothing when the channel has not opted in', async () => {
      const calls: unknown[] = [];
      const { channel, allocationId } = await seedLinked(0);
      await prisma.channelInstance.update({
        where: { id: channel.id },
        data: { draftAtSellout: false },
      });

      await runOneJob(statusConnector(calls), allocationId, channel.id);
      expect(calls).toEqual([]);
    });

    it('never drafts sealed product', async () => {
      // A sealed listing was created and imaged by the operator; its
      // visibility is theirs even when it sells out.
      const calls: unknown[] = [];
      const { channel, allocationId } = await seedLinked(0, 'SEALED');

      await runOneJob(statusConnector(calls), allocationId, channel.id);
      expect(calls).toEqual([]);
    });

    it('does nothing while stock remains', async () => {
      const calls: unknown[] = [];
      const { channel, allocationId } = await seedLinked(4);

      await runOneJob(statusConnector(calls), allocationId, channel.id);
      expect(calls).toEqual([]);
    });

    it('records a successful push even when the draft itself fails', async () => {
      // The quantity landed on the channel; the policy failing afterwards must
      // not turn a delivered push into a failed job that retries.
      const { channel, allocationId } = await seedLinked(0);

      await runOneJob(statusConnector([], { fail: true }), allocationId, channel.id);

      const allocation = await prisma.channelAllocation.findUniqueOrThrow({
        where: { id: allocationId },
      });
      expect(allocation.status).toBe('listed');
      expect(allocation.lastError).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  /** Drive exactly one job through a worker built like the real one. */
  async function runOneJob(
    connector: Connector,
    allocationId: string,
    channelInstanceId: string,
    options: { attempts?: number } = {},
  ): Promise<void> {
    const { OutboundWorker } = await import('./outbound.worker');

    const registry = { list: () => [], get: () => connector } as never;
    const channels = {
      resolve: async () => ({
        connector,
        enabled: true,
        displayName: 'Test Channel',
        ctx: {
          channelInstanceId,
          config: {},
          secrets: {},
          logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        } as Ctx,
      }),
    } as never;

    const instance = new OutboundWorker(
      connection,
      { get: () => false } as never,
      registry,
      channels,
      inventory,
      prisma as unknown as PrismaService,
      new SyncEventService(prisma as unknown as PrismaService),
      new AlertsService(prisma as unknown as PrismaService),
      // The real one: the sellout gates are the thing these tests exercise, so
      // faking it here would prove the worker calls a stub rather than that a
      // sold-out single actually gets drafted.
      new SelloutService(
        prisma as unknown as PrismaService,
        channels,
        new AlertsService(prisma as unknown as PrismaService),
      ),
    );

    // Reach past onModuleInit so the test drives one job deterministically
    // rather than racing a background worker.
    const process = (
      instance as unknown as { process: (job: unknown) => Promise<void> }
    ).process.bind(instance);

    try {
      await process({
        data: { channelInstanceId, allocationId, operation: 'quantity' },
        opts: { attempts: options.attempts ?? 1 },
        attemptsMade: 0,
        id: 'test-job',
      });
    } catch {
      // A failing push rethrows so BullMQ can retry it. The callers asserting
      // on failure care about the recorded outcome, not the rethrow.
    }
  }
});

function fakeConnector(
  updateQuantity: (ctx: Ctx, req: { quantity: number }) => Promise<void>,
): Connector {
  return {
    key: CONNECTOR_KEY,
    displayName: 'Test Connector',
    configSchema: { type: 'object', properties: {} },
    capabilities: ['listing.quantity'],
    rateLimit: { requestsPerSecond: 10 },
    updateQuantity: updateQuantity as Connector['updateQuantity'],
  };
}
