import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Connector, Ctx } from '@hub/connector-sdk';
import { createTcgPlayerConnector } from '@hub/connector-tcgplayer';
import { InboundQueue } from '../queue/inbound-queue.service';
import { INBOUND_QUEUE, OutboundQueue } from '../queue/outbound-queue.service';
import { InventoryService } from '../inventory/inventory.service';
import { InboundWorker } from '../sync/inbound.worker';
import { SyncEventService } from '../sync/sync-event.service';
import { AlertsService } from '../sync/alerts.service';
import { ChannelFilesService } from './channel-files.service';
import { parseCsv } from '@hub/connector-tcgplayer';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The TCGPlayer round trip, end to end against a real database and Redis
 * (ADR 0002).
 *
 * This is the test that matters for Phase 4. Everything else proves a piece:
 * the connector parses, the codec reads CRLF, the condition splits. This proves
 * the loop an operator actually performs — download a file, upload the
 * platform's export back, watch the ledger move — and that a re-upload does not
 * move it twice.
 *
 * Uses the committed fixtures of real exports, never a live account.
 */

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const describeFiles = dbUrl && redisUrl ? describe : describe.skip;

/**
 * Read a committed export fixture from the connector package.
 *
 * Located by walking up to the workspace root rather than by `import.meta.url`:
 * this file is typechecked under `module: CommonJS`, where that meta-property
 * is a compile error even though the test runner's ESM transform would accept
 * it. Walking up also survives being run from the repository root or from
 * `apps/api`, which `process.cwd()` alone would not.
 */
function fixture(name: string): Buffer {
  return readFileSync(join(workspaceRoot(), 'packages/connector-tcgplayer/test/fixtures', name));
}

function workspaceRoot(): string {
  let dir = process.cwd();
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find the workspace root above ${resolve(process.cwd())}`);
}

/** SKU ids that appear in both committed fixtures. */
const SKU_CREATURE = '1000002';
const SKU_LAND = '1000004';

let prisma: PrismaClient;
let connection: Redis;
let outbound: OutboundQueue;
let inbound: InboundQueue;
let inventory: InventoryService;
let files: ChannelFilesService;

const connector = createTcgPlayerConnector();

/** Stands in for ChannelContextFactory, which would need the whole DI graph. */
function channelContext(instanceId: string) {
  return {
    resolve: async () => ({
      connector,
      enabled: true,
      displayName: 'TCGPlayer',
      ctx: {
        channelInstanceId: instanceId,
        config: {},
        secrets: {},
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      } as Ctx,
    }),
  } as never;
}

/** Drive one queued job through the worker deterministically. */
async function runQueuedJobs(instanceId: string): Promise<void> {
  const worker = new InboundWorker(
    connection,
    { get: () => false } as never,
    channelContext(instanceId),
    inventory,
    prisma as unknown as PrismaService,
    new SyncEventService(prisma as unknown as PrismaService),
    new AlertsService(prisma as unknown as PrismaService),
  );

  const pending = await prisma.webhookEvent.findMany({
    where: { channelInstanceId: instanceId, status: 'received' },
    select: { id: true },
    orderBy: { receivedAt: 'asc' },
  });

  const process = (worker as unknown as { process: (job: unknown) => Promise<void> }).process.bind(
    worker,
  );
  for (const row of pending) {
    await process({ data: { webhookEventId: row.id }, id: row.id });
  }
}

describeFiles('channel file transport', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    outbound = new OutboundQueue(connection);
    inbound = new InboundQueue(connection);
    inventory = new InventoryService(prisma as unknown as PrismaService, outbound);
  });

  afterAll(async () => {
    await outbound.onModuleDestroy();
    await inbound.onModuleDestroy();
    await connection.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await new Queue(INBOUND_QUEUE, { connection }).obliterate({ force: true });
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

  /**
   * One channel with two mapped listings and one that was never mapped — the
   * shape a real seller has, because the hub cannot create TCGPlayer listings.
   */
  async function seed() {
    const channel = await prisma.channelInstance.create({
      data: { connectorKey: 'tcgplayer', displayName: 'My TCGPlayer Store', config: '{}' },
    });

    files = new ChannelFilesService(
      prisma as unknown as PrismaService,
      channelContext(channel.id),
      inventory,
      new SyncEventService(prisma as unknown as PrismaService),
      inbound,
    );

    const make = async (
      name: string,
      sku: { condition: string; printing: string; language: string },
      quantityOnHand: number,
      externalListingId: string | null,
      price: number,
    ) => {
      const catalogItem = await prisma.catalogItem.create({
        data: {
          name,
          searchName: name.toLowerCase(),
          game: 'Magic',
          setName: 'Example Set One',
          skus: { create: [sku] },
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
        price,
      });

      if (externalListingId) {
        await prisma.channelAllocation.update({
          where: { id: ledger.allocations[0]!.id },
          data: { externalListingId, listedQuantity: quantityOnHand },
        });
      }

      return item;
    };

    const creature = await make(
      'Example Creature, the Wanderer',
      { condition: 'NM', printing: 'HOLOFOIL', language: 'EN' },
      3,
      SKU_CREATURE,
      499,
    );
    const land = await make(
      'Example Land',
      { condition: 'NM', printing: 'FOIL', language: 'EN' },
      10,
      SKU_LAND,
      127500,
    );
    const unmapped = await make(
      'Never Listed Card',
      { condition: 'LP', printing: 'NORMAL', language: 'EN' },
      4,
      null,
      100,
    );

    return { channel, creature, land, unmapped };
  }

  // -------------------------------------------------------------------------

  describe('export', () => {
    it('renders every mapped listing in the platform format', async () => {
      await seed();
      const { file, total, unmapped } = await files.exportListings(
        (await prisma.channelInstance.findFirstOrThrow()).id,
      );

      const table = parseCsv(file.content.toString('utf8'));
      expect(table.headers[0]).toBe('TCGplayer Id');
      expect(table.rows.map((r) => r['TCGplayer Id']).sort()).toEqual([SKU_CREATURE, SKU_LAND]);
      expect(total).toBe(3);
      expect(unmapped).toBe(1);
    });

    /**
     * The export moves no stock, and that is the documented behaviour rather
     * than a limitation of this test. TCGPlayer's CSV import can only add to or
     * subtract from a quantity, never set one, so a file that carried a delta
     * would apply it again on every re-upload — and re-uploading being harmless
     * is what the whole manual loop rests on.
     */
    it('never asks TCGPlayer to move stock, however far the ledger has drifted', async () => {
      const { channel, land } = await seed();

      // Stock arrives and nothing has been pushed, so the ledger now wants 15
      // where we believe 10 is listed.
      await inventory.adjustQuantityOnHand(land.id, 5, { reason: 'intake' });

      const { file } = await files.exportListings(channel.id);
      const table = parseCsv(file.content.toString('utf8'));
      const row = table.rows.find((r) => r['TCGplayer Id'] === SKU_LAND);

      expect(row?.['Add to Quantity']).toBe('0');
      // The reference column carries what we believe is live, not the 15 the
      // ledger wants — writing that would read as a change that cannot happen.
      expect(row?.['Total Quantity']).toBe('10');
    });

    it('omits an allocation their validator would reject for having no price', async () => {
      const { channel } = await seed();
      await prisma.channelAllocation.updateMany({
        where: { channelInstanceId: channel.id, externalListingId: SKU_LAND },
        data: { price: null },
      });

      const { file } = await files.exportListings(channel.id);
      const table = parseCsv(file.content.toString('utf8'));

      expect(table.rows.map((r) => r['TCGplayer Id'])).toEqual([SKU_CREATURE]);
    });

    it('recombines our three SKU fields into one Condition string', async () => {
      const { channel } = await seed();
      const { file } = await files.exportListings(channel.id);
      const table = parseCsv(file.content.toString('utf8'));

      expect(table.rows.find((r) => r['TCGplayer Id'] === SKU_CREATURE)?.Condition).toBe(
        'Near Mint Holofoil',
      );
      expect(table.rows.find((r) => r['TCGplayer Id'] === SKU_LAND)?.Condition).toBe(
        'Near Mint Foil',
      );
    });

    it('records the export in the audit log', async () => {
      const { channel } = await seed();
      await files.exportListings(channel.id);

      const event = await prisma.syncEvent.findFirstOrThrow({
        where: { operation: 'exportListings' },
      });
      expect(event).toMatchObject({ direction: 'outbound', outcome: 'ok' });
    });
  });

  // -------------------------------------------------------------------------

  describe('orders import', () => {
    it('moves the ledger once the queued job runs', async () => {
      const { channel, creature, land } = await seed();

      const summary = await files.importFile(channel.id, 'orders', {
        filename: 'PullSheet.csv',
        content: fixture('pull-sheet.csv'),
      });

      expect(summary.queued).toBe(true);
      expect(summary.recordCount).toBe(7);

      // Nothing has moved yet: the endpoint stores and queues, exactly as the
      // webhook path does.
      expect((await inventory.getLedger(creature.id)).quantityOnHand).toBe(3);

      await runQueuedJobs(channel.id);

      expect((await inventory.getLedger(creature.id)).quantityOnHand).toBe(2);
      // Two orders against one row: 6 + 2 off a stock of 10.
      expect((await inventory.getLedger(land.id)).quantityOnHand).toBe(2);
    });

    it('records the order reference on each stock movement', async () => {
      const { channel } = await seed();
      await files.importFile(channel.id, 'orders', {
        filename: 'PullSheet.csv',
        content: fixture('pull-sheet.csv'),
      });
      await runQueuedJobs(channel.id);

      const notes = (
        await prisma.stockMovement.findMany({ where: { reason: 'sale' }, select: { note: true } })
      ).map((m) => m.note);

      expect(notes).toContain('AAAAAAAA-222222-BBBBB');
      expect(notes).toContain('AAAAAAAA-333333-CCCCC');
    });

    /**
     * The operator mistake this whole design has to survive. A pull sheet lists
     * orders awaiting fulfilment, so uploading it again next week re-lists the
     * same orders — and stock must not fall twice.
     */
    it('does not decrement twice when the same file is uploaded again', async () => {
      const { channel, creature } = await seed();
      const upload = () =>
        files.importFile(channel.id, 'orders', {
          filename: 'PullSheet.csv',
          content: fixture('pull-sheet.csv'),
        });

      await upload();
      await runQueuedJobs(channel.id);

      const second = await upload();
      expect(second.duplicate).toBe(true);
      await runQueuedJobs(channel.id);

      expect((await inventory.getLedger(creature.id)).quantityOnHand).toBe(2);
    });

    /**
     * A re-download is not byte-identical — shipped orders drop off it — so the
     * upload-level hash does not catch this one. The connector's per-sale key
     * has to.
     */
    it('does not decrement twice when a changed export repeats the same orders', async () => {
      const { channel, creature } = await seed();

      await files.importFile(channel.id, 'orders', {
        filename: 'PullSheet.csv',
        content: fixture('pull-sheet.csv'),
      });
      await runQueuedJobs(channel.id);

      // The same sale, in a file that is not byte-identical.
      const trimmed = Buffer.from(
        fixture('pull-sheet.csv')
          .toString('utf8')
          .split('\n')
          .filter((line, index) => index === 0 || line.includes(SKU_CREATURE))
          .join('\n'),
      );

      const second = await files.importFile(channel.id, 'orders', {
        filename: 'PullSheet-later.csv',
        content: trimmed,
      });
      expect(second.duplicate).toBe(false);
      await runQueuedJobs(channel.id);

      expect((await inventory.getLedger(creature.id)).quantityOnHand).toBe(2);
    });

    it('raises an alert for a sale against a listing we do not manage', async () => {
      const { channel } = await seed();
      await files.importFile(channel.id, 'orders', {
        filename: 'PullSheet.csv',
        content: fixture('pull-sheet.csv'),
      });
      await runQueuedJobs(channel.id);

      // The fixture contains SKUs this channel has no allocation for. Sellers
      // list things outside the hub, so it is not an error — but the operator
      // should know the two disagree about what exists.
      const alerts = await prisma.alert.findMany({ where: { kind: 'reconcile_drift' } });
      expect(alerts.length).toBeGreaterThan(0);
    });

    it('rejects a pricing export sent to the orders endpoint, and queues nothing', async () => {
      const { channel } = await seed();
      const summary = await files.importFile(channel.id, 'orders', {
        filename: 'MyPricing.csv',
        content: fixture('my-pricing.csv'),
      });

      expect(summary.queued).toBe(false);
      expect(summary.recordCount).toBe(0);
      expect(summary.problems[0]!.message).toMatch(/PullSheet/);
      expect(await prisma.webhookEvent.count()).toBe(0);
    });

    it('rejects an empty upload', async () => {
      const { channel } = await seed();
      await expect(
        files.importFile(channel.id, 'orders', {
          filename: 'empty.csv',
          content: Buffer.alloc(0),
        }),
      ).rejects.toThrow(/empty/i);
    });
  });

  // -------------------------------------------------------------------------

  describe('inventory import', () => {
    it('reports what the platform believes without touching the ledger', async () => {
      const { channel, creature } = await seed();

      const summary = await files.importFile(channel.id, 'inventory', {
        filename: 'MyPricing.csv',
        content: fixture('my-pricing.csv'),
      });

      expect(summary.recordCount).toBe(8);
      // The fixture says 3 for the creature and we believe 3, so it does not
      // differ; the land says 1 against our 10, so it does.
      expect(summary.differences).toContainEqual({
        externalListingId: SKU_LAND,
        platformQuantity: 1,
        believedQuantity: 10,
      });
      expect(summary.differences?.map((d) => d.externalListingId)).not.toContain(SKU_CREATURE);

      // Read-only until reconciliation exists (Phase 5).
      expect((await inventory.getLedger(creature.id)).quantityOnHand).toBe(3);
      expect(await prisma.stockMovement.count()).toBe(0);
    });

    it('counts rows that map to nothing we hold rather than calling them drift', async () => {
      const { channel } = await seed();
      const summary = await files.importFile(channel.id, 'inventory', {
        filename: 'MyPricing.csv',
        content: fixture('my-pricing.csv'),
      });

      // Six of the eight fixture rows are listings this channel does not manage.
      expect(summary.unmappedCount).toBe(6);
    });

    it('marks the channel as reconciled, which is a manual channel"s only clock', async () => {
      const { channel } = await seed();
      await files.importFile(channel.id, 'inventory', {
        filename: 'MyPricing.csv',
        content: fixture('my-pricing.csv'),
      });

      const row = await prisma.channelInstance.findUniqueOrThrow({ where: { id: channel.id } });
      expect(row.lastReconciledAt).not.toBeNull();
    });

    it('never queues anything, because live state has nowhere to go yet', async () => {
      const { channel } = await seed();
      await files.importFile(channel.id, 'inventory', {
        filename: 'MyPricing.csv',
        content: fixture('my-pricing.csv'),
      });

      expect(await prisma.webhookEvent.count()).toBe(0);
    });

    it('rejects a pull sheet sent to the inventory endpoint', async () => {
      const { channel } = await seed();
      const summary = await files.importFile(channel.id, 'inventory', {
        filename: 'PullSheet.csv',
        content: fixture('pull-sheet.csv'),
      });

      expect(summary.recordCount).toBe(0);
      expect(summary.problems[0]!.message).toMatch(/MyPricing/);
    });
  });

  // -------------------------------------------------------------------------

  describe('capability gating', () => {
    it('refuses a file operation the connector does not declare', async () => {
      const { channel } = await seed();

      const apiOnly: Connector = {
        key: 'api-only',
        displayName: 'API Only',
        configSchema: { type: 'object', properties: {} },
        capabilities: ['listing.quantity'],
        updateQuantity: async () => undefined,
      };

      const gated = new ChannelFilesService(
        prisma as unknown as PrismaService,
        {
          resolve: async () => ({
            connector: apiOnly,
            enabled: true,
            displayName: 'API Only',
            ctx: {} as Ctx,
          }),
        } as never,
        inventory,
        new SyncEventService(prisma as unknown as PrismaService),
        inbound,
      );

      await expect(gated.exportListings(channel.id)).rejects.toThrow(/does not produce file/i);
      await expect(
        gated.importFile(channel.id, 'orders', {
          filename: 'x.csv',
          content: Buffer.from('a,b\n1,2\n'),
        }),
      ).rejects.toThrow(/does not accept/i);
    });
  });
});
