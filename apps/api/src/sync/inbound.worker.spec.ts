import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Connector, Ctx, NormalizedEvent } from '@hub/connector-sdk';
import { OutboundQueue, outboundQueueName } from '../queue/outbound-queue.service';
import { InventoryService } from '../inventory/inventory.service';
import { InboundWorker } from './inbound.worker';
import { SyncEventService } from './sync-event.service';
import { AlertsService } from './alerts.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The inbound half: a persisted webhook becomes a decrement of the ledger, a
 * fan-out to the other channels, and an alert when something is wrong.
 *
 * Real database and Redis. The whole point is the seams — mapping a platform
 * listing id to an allocation, idempotency across redeliveries, and what
 * happens when a sale arrives for stock we do not have.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const describeInbound = dbUrl && redisUrl ? describe : describe.skip;

const CONNECTOR_KEY = 'test-inbound';
const LISTING = 'listing-abc';

let prisma: PrismaClient;
let connection: Redis;
let outbound: OutboundQueue;
let inventory: InventoryService;

/** A connector whose webhook body is simply a list of sales. */
function fakeConnector(): Connector {
  return {
    key: CONNECTOR_KEY,
    displayName: 'Test Inbound',
    configSchema: { type: 'object', properties: {} },
    capabilities: ['orders.webhook', 'listing.quantity'],
    verifyWebhook: () => true,
    parseWebhook: (_ctx: Ctx, rawBody: Buffer): NormalizedEvent[] => {
      const payload = JSON.parse(rawBody.toString('utf8')) as {
        sales: Array<{ listing: string; qty: number; ref?: string }>;
      };
      return payload.sales.map((sale, index) => ({
        type: 'sale',
        externalListingId: sale.listing,
        quantity: sale.qty,
        orderReference: sale.ref,
        externalEventId: createHash('sha256')
          .update(`${sale.listing}:${sale.qty}:${sale.ref ?? index}`)
          .digest('hex')
          .slice(0, 32),
      }));
    },
    updateQuantity: async () => undefined,
  };
}

function makeWorker(connector: Connector): InboundWorker {
  const channels = {
    resolve: async () => ({
      connector,
      enabled: true,
      displayName: 'Test',
      ctx: {
        channelInstanceId: 'x',
        config: {},
        secrets: {},
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      } as Ctx,
    }),
  } as never;

  return new InboundWorker(
    connection,
    { get: () => false } as never,
    channels,
    inventory,
    prisma as unknown as PrismaService,
    new SyncEventService(prisma as unknown as PrismaService),
    new AlertsService(prisma as unknown as PrismaService),
  );
}

/** Drive one job through the worker deterministically. */
async function runJob(worker: InboundWorker, webhookEventId: string): Promise<void> {
  const process = (worker as unknown as { process: (job: unknown) => Promise<void> }).process.bind(
    worker,
  );
  await process({ data: { webhookEventId }, id: 'job' });
}

describeInbound('inbound worker', () => {
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
    await prisma.webhookEvent.deleteMany();
    await prisma.syncEvent.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.channelInstance.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  async function seed(quantityOnHand: number, opts: { mapListing?: boolean } = {}) {
    const channel = await prisma.channelInstance.create({
      data: { connectorKey: CONNECTOR_KEY, displayName: 'Test Channel', config: '{}' },
    });

    const catalogItem = await prisma.catalogItem.create({
      data: {
        name: 'Card',
        searchName: 'card',
        skus: { create: [{ condition: 'NM', printing: 'NORMAL', language: 'EN' }] },
      },
      include: { skus: true },
    });

    const item = await prisma.inventoryItem.create({
      data: { skuId: catalogItem.skus[0]!.id, quantityOnHand },
    });

    const { ledger } = await inventory.upsertAllocation(item.id, {
      channelInstanceId: channel.id,
      mode: 'pooled',
      maxQuantity: null,
    });

    if (opts.mapListing !== false) {
      await prisma.channelAllocation.update({
        where: { id: ledger.allocations[0]!.id },
        data: { externalListingId: LISTING },
      });
    }

    return { channel, item, allocationId: ledger.allocations[0]!.id };
  }

  async function deliver(channelId: string, body: unknown): Promise<string> {
    const raw = JSON.stringify(body);
    const row = await prisma.webhookEvent.create({
      data: {
        channelInstanceId: channelId,
        externalEventId: createHash('sha256').update(raw).digest('hex'),
        headers: '{}',
        body: raw,
        status: 'received',
      },
    });
    return row.id;
  }

  it('decrements the ledger when a sale arrives', async () => {
    const { channel, item } = await seed(10);
    const eventId = await deliver(channel.id, {
      sales: [{ listing: LISTING, qty: 3, ref: 'o-1' }],
    });

    await runJob(makeWorker(fakeConnector()), eventId);

    const ledger = await inventory.getLedger(item.id);
    expect(ledger.quantityOnHand).toBe(7);

    const movement = await prisma.stockMovement.findFirst({ where: { reason: 'sale' } });
    expect(movement?.delta).toBe(-3);
    expect(movement?.note).toBe('o-1');
  });

  it('marks the webhook processed and records an ok sync event', async () => {
    const { channel } = await seed(5);
    const eventId = await deliver(channel.id, {
      sales: [{ listing: LISTING, qty: 1, ref: 'o-2' }],
    });

    await runJob(makeWorker(fakeConnector()), eventId);

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.status).toBe('processed');
    expect(row.processedAt).not.toBeNull();

    const events = await prisma.syncEvent.findMany({ where: { direction: 'inbound' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'ok', operation: 'sale' });
  });

  it('queues an outbound push so the channel learns the new quantity', async () => {
    const { channel } = await seed(10);
    const eventId = await deliver(channel.id, { sales: [{ listing: LISTING, qty: 2 }] });

    await runJob(makeWorker(fakeConnector()), eventId);

    // §6 step 3. InventoryService fans out; the selling channel is included
    // because its own listed quantity changed too.
    expect((await outbound.counts(CONNECTOR_KEY)).waiting).toBeGreaterThan(0);
  });

  /**
   * A platform can report the same line in two payloads — an order creation
   * and a later update — which are not byte-identical, so the ingress
   * delivery-hash dedupe does not catch them.
   */
  it('applies a sale once even across different deliveries', async () => {
    const { channel, item } = await seed(10);
    const worker = makeWorker(fakeConnector());

    const first = await deliver(channel.id, { sales: [{ listing: LISTING, qty: 2, ref: 'o-9' }] });
    await runJob(worker, first);

    // Same sale, different envelope.
    const second = await deliver(channel.id, {
      sales: [{ listing: LISTING, qty: 2, ref: 'o-9' }],
      updatedAt: 'later',
    });
    await runJob(worker, second);

    expect((await inventory.getLedger(item.id)).quantityOnHand).toBe(8);
  });

  it('does not reprocess a webhook already marked processed', async () => {
    const { channel, item } = await seed(10);
    const worker = makeWorker(fakeConnector());
    const eventId = await deliver(channel.id, { sales: [{ listing: LISTING, qty: 1 }] });

    await runJob(worker, eventId);
    await runJob(worker, eventId);

    expect((await inventory.getLedger(item.id)).quantityOnHand).toBe(9);
  });

  /**
   * Sellers list things outside the hub. Not an error, but the operator needs
   * to know the ledger and the channel disagree about what exists.
   */
  it('alerts rather than failing when a sale maps to no allocation', async () => {
    const { channel, item } = await seed(10, { mapListing: false });
    const eventId = await deliver(channel.id, { sales: [{ listing: 'unknown-listing', qty: 1 }] });

    await runJob(makeWorker(fakeConnector()), eventId);

    expect((await inventory.getLedger(item.id)).quantityOnHand).toBe(10);

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'reconcile_drift', status: 'open' });

    const events = await prisma.syncEvent.findMany({ where: { direction: 'inbound' } });
    expect(events[0]).toMatchObject({ outcome: 'conflict' });
  });

  /**
   * §6 step 4: clamp to zero, flag a conflict, alert a human. Never attempt an
   * automated cancellation.
   */
  it('clamps an oversell and raises a critical alert', async () => {
    const { channel, item } = await seed(2);
    const eventId = await deliver(channel.id, { sales: [{ listing: LISTING, qty: 5 }] });

    await runJob(makeWorker(fakeConnector()), eventId);

    expect((await inventory.getLedger(item.id)).quantityOnHand).toBe(0);

    const alerts = await prisma.alert.findMany();
    expect(alerts.some((a) => a.kind === 'oversell' && a.severity === 'critical')).toBe(true);

    const events = await prisma.syncEvent.findMany({ where: { direction: 'inbound' } });
    expect(events[0]).toMatchObject({ outcome: 'conflict' });
  });

  it('applies every line of a multi-line order', async () => {
    const { channel, item } = await seed(10);
    const eventId = await deliver(channel.id, {
      sales: [
        { listing: LISTING, qty: 2, ref: 'o-a' },
        { listing: LISTING, qty: 3, ref: 'o-b' },
      ],
    });

    await runJob(makeWorker(fakeConnector()), eventId);

    expect((await inventory.getLedger(item.id)).quantityOnHand).toBe(5);
  });

  it('does not retry a payload it can never parse', async () => {
    const { channel } = await seed(5);
    const eventId = await deliver(channel.id, 'not-the-expected-shape');

    const broken = {
      ...fakeConnector(),
      parseWebhook: () => {
        throw new Error('bad shape');
      },
    };
    await expect(runJob(makeWorker(broken as Connector), eventId)).rejects.toThrow(/bad shape/);

    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/bad shape/);
  });

  it('gives up on a webhook row that no longer exists', async () => {
    await expect(runJob(makeWorker(fakeConnector()), 'missing-id')).rejects.toThrow(
      /no longer exists/,
    );
  });
});
