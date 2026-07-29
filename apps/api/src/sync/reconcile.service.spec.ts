import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, decodeJson } from '@hub/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Connector, Ctx, LiveListingState } from '@hub/connector-sdk';
import { OutboundQueue, outboundQueueName } from '../queue/outbound-queue.service';
import { InventoryService } from '../inventory/inventory.service';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ReconcileService } from './reconcile.service';
import { SyncEventService } from './sync-event.service';
import { AlertsService } from './alerts.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Reconciliation against a real database and queue.
 *
 * The pure diff is covered exhaustively in reconcile.spec.ts. What matters here
 * is everything around it: that a drift raises exactly one alert and not one
 * per listing, that a clean run clears it again, that auto-correction queues a
 * push only when the operator opted in, and — most importantly — that nothing
 * on this path ever writes a quantity into the ledger.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const describeReconcile = dbUrl && redisUrl ? describe : describe.skip;

const CONNECTOR_KEY = 'test-reconcile';

let prisma: PrismaClient;
let connection: Redis;
let outbound: OutboundQueue;
let inventory: InventoryService;

/** What the fake platform will report on the next call. */
let liveState: LiveListingState[] = [];
let fetchCalls: string[][] = [];

function fakeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    key: CONNECTOR_KEY,
    displayName: 'Test Reconcile',
    configSchema: { type: 'object', properties: {} },
    capabilities: ['reconcile', 'listing.quantity'],
    updateQuantity: async () => undefined,
    fetchLiveState: async (_ctx: Ctx, ids: string[]) => {
      fetchCalls.push(ids);
      // Mirrors the SDK contract: ids the platform does not know are omitted,
      // never returned as quantity zero.
      return liveState.filter((state) => ids.includes(state.externalListingId));
    },
    ...overrides,
  };
}

function makeService(connector: Connector): ReconcileService {
  const registry = new ConnectorRegistry();
  registry.register(connector);

  const channels = {
    resolve: async (channelInstanceId: string) => {
      const row = await prisma.channelInstance.findUniqueOrThrow({
        where: { id: channelInstanceId },
      });
      return {
        connector,
        enabled: row.enabled,
        displayName: row.displayName,
        ctx: {
          channelInstanceId,
          config: {},
          secrets: {},
          logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        } as Ctx,
      };
    },
  } as never;

  return new ReconcileService(
    prisma as unknown as PrismaService,
    channels,
    registry,
    inventory,
    new SyncEventService(prisma as unknown as PrismaService),
    outbound,
    new AlertsService(prisma as unknown as PrismaService),
  );
}

describeReconcile('ReconcileService', () => {
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
    liveState = [];
    fetchCalls = [];

    await prisma.syncEvent.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.channelInstance.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
  });

  /**
   * One channel with two listings the hub has successfully pushed, and one
   * allocation never mapped to the platform — the shape a real seller has.
   */
  async function seed(options: { autoCorrect?: boolean } = {}) {
    const channel = await prisma.channelInstance.create({
      data: {
        connectorKey: CONNECTOR_KEY,
        displayName: 'Test Channel',
        config: '{}',
        reconcileAutoCorrect: options.autoCorrect ?? false,
      },
    });

    const make = async (name: string, onHand: number, listingId: string | null) => {
      const catalogItem = await prisma.catalogItem.create({
        data: {
          name,
          searchName: name.toLowerCase(),
          skus: { create: [{ condition: 'NM', printing: 'NORMAL', language: 'EN' }] },
        },
        include: { skus: true },
      });

      const item = await prisma.inventoryItem.create({
        data: { skuId: catalogItem.skus[0]!.id, quantityOnHand: onHand },
      });

      const { ledger } = await inventory.upsertAllocation(item.id, {
        channelInstanceId: channel.id,
        mode: 'pooled',
        maxQuantity: null,
        price: 1000,
      });

      if (listingId) {
        // listedQuantity matching on-hand stands for a push that succeeded.
        await prisma.channelAllocation.update({
          where: { id: ledger.allocations[0]!.id },
          data: { externalListingId: listingId, listedQuantity: onHand, status: 'listed' },
        });
      }

      return { item, allocationId: ledger.allocations[0]!.id };
    };

    const alpha = await make('Alpha', 5, 'listing-alpha');
    const beta = await make('Beta', 3, 'listing-beta');
    const unmapped = await make('Never Listed', 4, null);

    // Creating an allocation legitimately queues its first push. Clearing them
    // here means the auto-correction assertions below are about what
    // reconciliation queued and nothing else.
    await new Queue(outboundQueueName(CONNECTOR_KEY), { connection }).obliterate({ force: true });

    return { channel, alpha, beta, unmapped };
  }

  const inSync = () => [
    { externalListingId: 'listing-alpha', quantity: 5, active: true },
    { externalListingId: 'listing-beta', quantity: 3, active: true },
  ];

  // -------------------------------------------------------------------------

  it('reports nothing and raises no alert when the channel agrees', async () => {
    const { channel } = await seed();
    liveState = inSync();

    const outcome = await makeService(fakeConnector()).reconcileChannel(channel.id);

    expect(outcome.report.drifts).toEqual([]);
    expect(outcome.summary).toMatch(/everything matches/);
    expect(await prisma.alert.count({ where: { kind: 'reconcile_drift' } })).toBe(0);
  });

  it('skips an allocation that was never mapped to the platform', async () => {
    const { channel } = await seed();
    liveState = inSync();

    const outcome = await makeService(fakeConnector()).reconcileChannel(channel.id);

    // Two listings compared, not three. One that has never been mapped has
    // nothing on the channel to differ from, and reporting it as missing every
    // night would be a permanent non-finding.
    expect(outcome.report.checked).toBe(2);
    expect(fetchCalls).toEqual([['listing-alpha', 'listing-beta']]);
  });

  it('finds a quantity difference and records it in the audit log', async () => {
    const { channel } = await seed();
    liveState = [
      { externalListingId: 'listing-alpha', quantity: 1, active: true },
      { externalListingId: 'listing-beta', quantity: 3, active: true },
    ];

    const outcome = await makeService(fakeConnector()).reconcileChannel(channel.id);

    expect(outcome.report.drifts).toHaveLength(1);
    expect(outcome.report.drifts[0]).toMatchObject({ kind: 'quantity', ours: 5, theirs: 1 });

    const event = await prisma.syncEvent.findFirstOrThrow({
      where: { direction: 'reconcile', operation: 'fetchLiveState' },
    });
    expect(event.outcome).toBe('conflict');
    expect(decodeJson<{ driftCount: number }>(event.payload, { driftCount: 0 }).driftCount).toBe(1);
  });

  /**
   * The rule that keeps the alert inbox usable. One alert per drifting listing
   * would put hundreds in front of an operator after a single bad night and
   * train them to ignore all of them.
   */
  it('raises exactly one alert however many listings differ', async () => {
    const { channel } = await seed();
    liveState = [
      { externalListingId: 'listing-alpha', quantity: 0, active: true },
      { externalListingId: 'listing-beta', quantity: 0, active: true },
    ];

    await makeService(fakeConnector()).reconcileChannel(channel.id);

    const alerts = await prisma.alert.findMany({ where: { kind: 'reconcile_drift' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toMatch(/differs on 2 listings/);
  });

  it('refreshes the existing alert rather than stacking a second', async () => {
    const { channel } = await seed();
    const service = makeService(fakeConnector());

    liveState = [
      { externalListingId: 'listing-alpha', quantity: 0, active: true },
      { externalListingId: 'listing-beta', quantity: 3, active: true },
    ];
    await service.reconcileChannel(channel.id);

    liveState = [
      { externalListingId: 'listing-alpha', quantity: 0, active: true },
      { externalListingId: 'listing-beta', quantity: 0, active: true },
    ];
    await service.reconcileChannel(channel.id);

    const alerts = await prisma.alert.findMany({ where: { kind: 'reconcile_drift' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.title).toMatch(/2 listings/);
  });

  it('clears its own alert once a run comes back clean', async () => {
    const { channel } = await seed();
    const service = makeService(fakeConnector());

    liveState = [
      { externalListingId: 'listing-alpha', quantity: 0, active: true },
      { externalListingId: 'listing-beta', quantity: 3, active: true },
    ];
    await service.reconcileChannel(channel.id);
    expect(await prisma.alert.count({ where: { status: 'open' } })).toBe(1);

    liveState = inSync();
    await service.reconcileChannel(channel.id);

    const alert = await prisma.alert.findFirstOrThrow({ where: { kind: 'reconcile_drift' } });
    expect(alert.status).toBe('resolved');
  });

  /**
   * The inbound worker files reconcile_drift too, for a sale against a listing
   * we do not manage. That is a different fact about a different moment, and a
   * clean sweep must not quietly close it.
   */
  it('does not close a drift alert it did not raise', async () => {
    const { channel } = await seed();
    liveState = inSync();

    const foreign = await prisma.alert.create({
      data: {
        kind: 'reconcile_drift',
        severity: 'info',
        channelInstanceId: channel.id,
        title: 'Sale for an unmapped listing',
        status: 'open',
      },
    });

    await makeService(fakeConnector()).reconcileChannel(channel.id);

    const after = await prisma.alert.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.status).toBe('open');
  });

  it('stamps lastReconciledAt, which is how the UI shows freshness', async () => {
    const { channel } = await seed();
    liveState = inSync();

    await makeService(fakeConnector()).reconcileChannel(channel.id);

    const row = await prisma.channelInstance.findUniqueOrThrow({ where: { id: channel.id } });
    expect(row.lastReconciledAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------

  describe('auto-correction', () => {
    it('queues nothing when the channel has not opted in', async () => {
      const { channel } = await seed({ autoCorrect: false });
      liveState = [
        { externalListingId: 'listing-alpha', quantity: 1, active: true },
        { externalListingId: 'listing-beta', quantity: 3, active: true },
      ];

      const outcome = await makeService(fakeConnector()).reconcileChannel(channel.id);

      expect(outcome.corrected).toBe(0);
      expect(await outbound.counts(CONNECTOR_KEY)).toMatchObject({ waiting: 0 });
    });

    it('queues a re-push for a quantity difference when it has', async () => {
      const { channel, alpha } = await seed({ autoCorrect: true });
      liveState = [
        { externalListingId: 'listing-alpha', quantity: 1, active: true },
        { externalListingId: 'listing-beta', quantity: 3, active: true },
      ];

      const outcome = await makeService(fakeConnector()).reconcileChannel(channel.id);

      expect(outcome.corrected).toBe(1);
      const jobs = await outbound.queueFor(CONNECTOR_KEY).getJobs(['waiting', 'delayed']);
      expect(jobs.map((j) => j.data.allocationId)).toEqual([alpha.allocationId]);
    });

    it('will not reactivate a listing the seller pulled on the platform', async () => {
      const { channel } = await seed({ autoCorrect: true });
      liveState = [
        { externalListingId: 'listing-alpha', quantity: 5, active: false },
        { externalListingId: 'listing-beta', quantity: 3, active: true },
      ];

      const outcome = await makeService(fakeConnector()).reconcileChannel(channel.id);

      expect(outcome.report.drifts.map((d) => d.kind)).toEqual(['inactive']);
      expect(outcome.corrected).toBe(0);
    });

    /**
     * §6 permits correction in one direction only. This is the assertion that
     * pins it: whatever the channel reports, the ledger does not move.
     */
    it('never writes a quantity into the ledger', async () => {
      const { channel, alpha } = await seed({ autoCorrect: true });
      liveState = [
        { externalListingId: 'listing-alpha', quantity: 99, active: true },
        { externalListingId: 'listing-beta', quantity: 0, active: true },
      ];

      await makeService(fakeConnector()).reconcileChannel(channel.id);

      expect((await inventory.getLedger(alpha.item.id)).quantityOnHand).toBe(5);
      expect(await prisma.stockMovement.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('what cannot be reconciled', () => {
    it('refuses a connector that does not report live state', async () => {
      const { channel } = await seed();
      const fileBased = fakeConnector({
        capabilities: ['listing.export'],
        fetchLiveState: undefined,
        updateQuantity: undefined,
        exportListings: async () => ({
          filename: 'x.csv',
          contentType: 'text/csv',
          content: Buffer.from(''),
        }),
      });

      await expect(makeService(fileBased).reconcileChannel(channel.id)).rejects.toThrow(
        /does not report live listing state/i,
      );
    });

    it('refuses a disabled channel', async () => {
      const { channel } = await seed();
      await prisma.channelInstance.update({
        where: { id: channel.id },
        data: { enabled: false },
      });

      await expect(makeService(fakeConnector()).reconcileChannel(channel.id)).rejects.toThrow(
        /disabled/i,
      );
    });

    it('records an error in the audit log when the platform call fails', async () => {
      const { channel } = await seed();
      const broken = fakeConnector({
        fetchLiveState: async () => {
          throw new Error('token expired');
        },
      });

      await expect(makeService(broken).reconcileChannel(channel.id)).rejects.toThrow(
        /token expired/,
      );

      const event = await prisma.syncEvent.findFirstOrThrow({ where: { direction: 'reconcile' } });
      expect(event).toMatchObject({ outcome: 'error', detail: 'token expired' });
    });
  });

  // -------------------------------------------------------------------------

  describe('the nightly sweep', () => {
    it('walks every eligible channel', async () => {
      const { channel } = await seed();
      liveState = inSync();

      const outcomes = await makeService(fakeConnector()).reconcileAll();

      expect(outcomes.map((o) => o.channelInstanceId)).toEqual([channel.id]);
    });

    it('skips a disabled channel rather than failing on it', async () => {
      const { channel } = await seed();
      await prisma.channelInstance.update({
        where: { id: channel.id },
        data: { enabled: false },
      });

      await expect(makeService(fakeConnector()).reconcileAll()).resolves.toEqual([]);
    });

    /**
     * One channel with an expired token must not stop the others being checked
     * — that is the night the sweep matters most.
     */
    it('carries on after one channel fails', async () => {
      const { channel } = await seed();
      const second = await prisma.channelInstance.create({
        data: { connectorKey: CONNECTOR_KEY, displayName: 'Second', config: '{}' },
      });
      liveState = inSync();

      let calls = 0;
      const flaky = fakeConnector({
        fetchLiveState: async (_ctx: Ctx, ids: string[]) => {
          if (calls++ === 0) throw new Error('token expired');
          return liveState.filter((state) => ids.includes(state.externalListingId));
        },
      });

      const outcomes = await makeService(flaky).reconcileAll();

      // The first channel threw; the second still ran. It has no allocations,
      // so its report is empty rather than absent.
      expect(outcomes.map((o) => o.channelInstanceId)).toEqual([second.id]);
      expect(channel.id).not.toBe(second.id);
    });
  });
});
