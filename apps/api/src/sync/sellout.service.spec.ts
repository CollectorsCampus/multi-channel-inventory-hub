import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import { SelloutService } from './sellout.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChannelContextFactory } from '../connectors/channel-context.service';
import type { AlertsService } from './alerts.service';

/**
 * The sweep's own judgement, with the connector faked at its seam.
 *
 * What is worth pinning is which listings the sweep offers to the platform at
 * all — the gates are the whole feature, and every one of them exists because
 * the wrong answer hides a card that is for sale. The connector's own
 * `onlyIfSoldOut` check is a separate guard tested in the connector; here it is
 * enough that the flag is always sent.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;

interface StatusRequest {
  externalListingId: string;
  status: string;
  onlyIfSoldOut?: boolean;
}

/** Records what it was asked to draft; reports every one as changed. */
function fakeConnector(options: { capable?: boolean; failOn?: string } = {}) {
  const calls: StatusRequest[] = [];
  const connector = {
    key: 'shopify',
    displayName: 'Shopify',
    capabilities: options.capable === false ? ['listing.quantity'] : ['listing.status'],
    rateLimit: { requestsPerSecond: 100, burst: 100 },
    updateListingStatus: vi.fn(async (_ctx: unknown, req: StatusRequest) => {
      calls.push(req);
      if (options.failOn && req.externalListingId === options.failOn) {
        throw new Error('Shopify said no');
      }
      return { changed: true };
    }),
  };

  const channels = {
    resolve: async () => ({ connector, ctx: {}, displayName: 'Test Store' }),
  } as unknown as ChannelContextFactory;

  return { channels, calls };
}

const alerts = {
  raiseFlag: vi.fn(async () => ({ id: 'a', occurrences: 1 })),
  clearFlag: vi.fn(async () => true),
} as unknown as AlertsService;

async function seedChannel(draftAtSellout = true) {
  return prisma.channelInstance.create({
    data: {
      connectorKey: 'shopify',
      displayName: 'Test Store',
      config: '{}',
      draftAtSellout,
    },
  });
}

async function seedListing(options: {
  channelId: string;
  condition: string;
  quantityOnHand: number;
  listedQuantity: number;
  externalListingId: string | null;
}) {
  const catalogItem = await prisma.catalogItem.create({
    data: {
      name: `Card ${options.externalListingId ?? 'none'}`,
      searchName: 'card',
      skus: { create: [{ condition: options.condition, printing: 'NORMAL', language: 'EN' }] },
    },
    include: { skus: true },
  });
  const item = await prisma.inventoryItem.create({
    data: { skuId: catalogItem.skus[0]!.id, quantityOnHand: options.quantityOnHand },
  });
  await prisma.channelAllocation.create({
    data: {
      inventoryItemId: item.id,
      channelInstanceId: options.channelId,
      mode: 'pooled',
      listedQuantity: options.listedQuantity,
      externalListingId: options.externalListingId,
    },
  });
  return item.id;
}

describeDb('SelloutService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
    await prisma.alert.deleteMany();
    await prisma.channelInstance.deleteMany();
  });

  function build(options: Parameters<typeof fakeConnector>[0] = {}) {
    const { channels, calls } = fakeConnector(options);
    return {
      service: new SelloutService(prisma as unknown as PrismaService, channels, alerts),
      calls,
    };
  }

  it('drafts a sold-out single, always with the platform-side guard', async () => {
    const channel = await seedChannel();
    await seedListing({
      channelId: channel.id,
      condition: 'NM',
      quantityOnHand: 0,
      listedQuantity: 0,
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    const { service, calls } = build();
    const report = await service.sweepChannel(channel.id);

    expect(report.checked).toBe(1);
    expect(report.drafted).toBe(1);
    expect(calls).toEqual([
      {
        externalListingId: 'gid://shopify/ProductVariant/1',
        status: 'draft',
        // Never optional: without it the hub would be deciding a product is
        // sold out from its own numbers, and a sibling variant with copies
        // would be pulled off the storefront with it.
        onlyIfSoldOut: true,
      },
    ]);
  });

  /**
   * A sealed listing was created and photographed by the operator, and an
   * Elite Trainer Box out of stock is a page a shop may well want to keep.
   * Its visibility is theirs.
   */
  it('leaves sealed and non-applicable stock alone', async () => {
    const channel = await seedChannel();
    for (const condition of ['SEALED', 'NA']) {
      await seedListing({
        channelId: channel.id,
        condition,
        quantityOnHand: 0,
        listedQuantity: 0,
        externalListingId: `gid://shopify/ProductVariant/${condition}`,
      });
    }

    const { service, calls } = build();
    const report = await service.sweepChannel(channel.id);

    expect(report.checked).toBe(0);
    expect(calls).toEqual([]);
  });

  /**
   * The conservative half of the candidate test, and the one that matters: a
   * card with stock in the ledger may have a quantity push in flight, and
   * drafting just ahead of one leaves it back in stock and invisible — which
   * nothing here ever undoes.
   */
  it('will not touch a listing the ledger still has stock for', async () => {
    const channel = await seedChannel();
    await seedListing({
      channelId: channel.id,
      condition: 'NM',
      quantityOnHand: 3,
      listedQuantity: 0,
      externalListingId: 'gid://shopify/ProductVariant/2',
    });

    const { service, calls } = build();
    expect((await service.sweepChannel(channel.id)).checked).toBe(0);
    expect(calls).toEqual([]);
  });

  it('will not touch a listing we believe is still advertising copies', async () => {
    const channel = await seedChannel();
    await seedListing({
      channelId: channel.id,
      condition: 'NM',
      quantityOnHand: 0,
      listedQuantity: 2,
      externalListingId: 'gid://shopify/ProductVariant/3',
    });

    const { service, calls } = build();
    expect((await service.sweepChannel(channel.id)).checked).toBe(0);
    expect(calls).toEqual([]);
  });

  it('skips an allocation with no listing to draft', async () => {
    const channel = await seedChannel();
    await seedListing({
      channelId: channel.id,
      condition: 'NM',
      quantityOnHand: 0,
      listedQuantity: 0,
      externalListingId: null,
    });

    const { service, calls } = build();
    expect((await service.sweepChannel(channel.id)).checked).toBe(0);
    expect(calls).toEqual([]);
  });

  /**
   * Refused rather than answered with an empty report: "off" and "nothing sold
   * out" are different facts with different fixes, and an empty report would
   * let an operator conclude the storefront is already tidy.
   */
  it('refuses a channel that has the policy switched off', async () => {
    const channel = await seedChannel(false);
    await seedListing({
      channelId: channel.id,
      condition: 'NM',
      quantityOnHand: 0,
      listedQuantity: 0,
      externalListingId: 'gid://shopify/ProductVariant/4',
    });

    const { service } = build();
    await expect(service.sweepChannel(channel.id)).rejects.toThrow(/does not draft sold-out/);
  });

  it('refuses a connector that cannot change a listing’s status', async () => {
    const channel = await seedChannel();
    const { service } = build({ capable: false });
    await expect(service.sweepChannel(channel.id)).rejects.toThrow(/cannot change/);
  });

  /** One failure is reported and the rest still land, as every batch here does. */
  it('reports a failure per listing and carries on', async () => {
    const channel = await seedChannel();
    await seedListing({
      channelId: channel.id,
      condition: 'NM',
      quantityOnHand: 0,
      listedQuantity: 0,
      externalListingId: 'gid://shopify/ProductVariant/bad',
    });
    await seedListing({
      channelId: channel.id,
      condition: 'LP',
      quantityOnHand: 0,
      listedQuantity: 0,
      externalListingId: 'gid://shopify/ProductVariant/good',
    });

    const { service } = build({ failOn: 'gid://shopify/ProductVariant/bad' });
    const report = await service.sweepChannel(channel.id);

    expect(report.drafted).toBe(1);
    expect(report.problems).toHaveLength(1);
    expect(alerts.raiseFlag).toHaveBeenCalledTimes(1);
  });

  /**
   * The flag clears itself, so an operator who fixed a bad token does not have
   * to close the alert by hand and wonder whether it was really resolved.
   */
  it('clears its own flag on a clean run', async () => {
    const channel = await seedChannel();
    const { service } = build();

    await service.sweepChannel(channel.id);

    expect(alerts.raiseFlag).not.toHaveBeenCalled();
    expect(alerts.clearFlag).toHaveBeenCalledWith('sync_failure', channel.id, 'sellout:sweep');
  });

  /** The sweep only visits channels that asked for it. */
  it('sweeps only enabled channels that opted in', async () => {
    const optedIn = await seedChannel(true);
    const optedOut = await seedChannel(false);
    for (const channel of [optedIn, optedOut]) {
      await seedListing({
        channelId: channel.id,
        condition: 'NM',
        quantityOnHand: 0,
        listedQuantity: 0,
        externalListingId: `gid://shopify/ProductVariant/${channel.id}`,
      });
    }

    const { service, calls } = build();
    const report = await service.sweep();

    expect(report.drafted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.externalListingId).toBe(`gid://shopify/ProductVariant/${optedIn.id}`);
  });
});
