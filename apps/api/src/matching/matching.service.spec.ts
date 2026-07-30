import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { CatalogCandidate, ChannelListingPage, Connector, Ctx } from '@hub/connector-sdk';
import { MatchingService } from './matching.service';
import { IntakeService } from '../inventory/intake.service';
import { InventoryService } from '../inventory/inventory.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import type { ChannelContextFactory } from '../connectors/channel-context.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Confirmation against a real database.
 *
 * The properties worth testing are all about *not* making a mess: confirming the
 * same link twice must not duplicate an allocation, two inventory items must not
 * both claim one channel listing, and linking must not credit the operator stock
 * they never counted. None of that is observable without the constraints.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const ETB: CatalogCandidate & { sourceKey: string } = {
  sourceKey: 'tcgcsv',
  sourceId: '704143',
  name: '30th Celebration Elite Trainer Box',
  game: 'Pokemon',
  setName: '30th Celebration',
  externalIds: { tcgcsv: '704143', tcgplayer: '704143' },
  marketPrice: 20435,
};

const PIKACHU: CatalogCandidate & { sourceKey: string } = {
  sourceKey: 'tcgcsv',
  sourceId: '696676',
  name: 'Pikachu ex',
  game: 'Pokemon',
  setName: '30th Celebration',
  externalIds: { tcgcsv: '696676', tcgplayer: '696676' },
};

const ETB_GID = 'gid://shopify/ProductVariant/1';
const PIKACHU_GID = 'gid://shopify/ProductVariant/2';

let prisma: PrismaClient;
let matching: MatchingService;
let channelId: string;
let enumerateListings: ReturnType<typeof vi.fn>;
let search: ReturnType<typeof vi.fn>;
let canRefetch: ReturnType<typeof vi.fn>;

describeDb('MatchingService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.stockMovement.deleteMany();
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogExternalRef.deleteMany();
    await prisma.catalogItem.deleteMany();
    await prisma.channelInstance.deleteMany();

    const channel = await prisma.channelInstance.create({
      data: { connectorKey: 'shopify', displayName: 'Test Store', config: '{}' },
    });
    channelId = channel.id;

    enumerateListings = vi.fn(async (): Promise<ChannelListingPage> => ({
      listings: [
        {
          externalListingId: ETB_GID,
          title: '30th Celebration Elite Trainer Box',
          price: 20999,
        },
        { externalListingId: PIKACHU_GID, title: 'Pikachu ex - Near Mint Foil', price: 350 },
      ],
    }));

    const connector = {
      key: 'shopify',
      displayName: 'Shopify',
      capabilities: ['listing.enumerate', 'listing.quantity'],
      enumerateListings,
    } as unknown as Connector;

    const channels = {
      resolve: vi.fn(async () => ({
        connector,
        ctx: {
          channelInstanceId: channelId,
          config: {},
          secrets: {},
          logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        } as Ctx,
        displayName: 'Test Store',
        enabled: true,
      })),
    } as unknown as ChannelContextFactory;

    search = vi.fn(async () => [ETB, PIKACHU]);
    const sources = {
      get: vi.fn(() => ({ key: 'tcgcsv', search })),
    } as unknown as CatalogSourceRegistry;

    canRefetch = vi.fn(() => true);
    const catalog = {
      fetchCandidate: vi.fn(async (_key: string, sourceId: string) => {
        if (sourceId === ETB.sourceId) return ETB;
        if (sourceId === PIKACHU.sourceId) return PIKACHU;
        return null;
      }),
      canRefetch,
    } as unknown as CatalogService;

    const inventory = new InventoryService(prisma as unknown as PrismaService);
    const intake = new IntakeService(prisma as unknown as PrismaService, catalog, inventory);

    matching = new MatchingService(
      prisma as unknown as PrismaService,
      channels,
      sources,
      catalog,
      intake,
      inventory,
    );
  });

  const propose = () =>
    matching.propose({
      channelInstanceId: channelId,
      sourceKey: 'tcgcsv',
      setName: '30th Celebration',
    });

  const confirmEtb = (price?: number) =>
    matching.confirm(channelId, [
      {
        externalListingId: ETB_GID,
        sourceKey: 'tcgcsv',
        sourceId: ETB.sourceId,
        condition: 'SEALED',
        ...(price !== undefined ? { price } : {}),
      },
    ]);

  describe('propose', () => {
    it('matches both listings against the set', async () => {
      const result = await propose();

      expect(result.candidateCount).toBe(2);
      expect(result.summary.matched).toBe(2);
      expect(result.proposals.every((p) => p.status === 'matched')).toBe(true);
    });

    it('refuses an unscoped run rather than walking the catalogue', async () => {
      await expect(
        matching.propose({ channelInstanceId: channelId, sourceKey: 'tcgcsv', setName: '  ' }),
      ).rejects.toThrow(/set name is required/i);

      // Refused before either side was touched.
      expect(enumerateListings).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    });

    it('skips a listing that already has an allocation', async () => {
      await confirmEtb();

      const result = await propose();

      // Re-proposing a working link invites the operator to repoint a live listing.
      expect(result.skipped).toBe(1);
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.listing.externalListingId).toBe(PIKACHU_GID);
    });

    it('refuses a channel that cannot enumerate', async () => {
      const manual = {
        resolve: vi.fn(async () => ({
          connector: {
            key: 'tcgplayer',
            displayName: 'TCGPlayer',
            capabilities: ['orders.import'],
          } as unknown as Connector,
          ctx: {} as Ctx,
          displayName: 'TCGPlayer',
          enabled: true,
        })),
      } as unknown as ChannelContextFactory;

      const service = new MatchingService(
        prisma as unknown as PrismaService,
        manual,
        { get: vi.fn() } as unknown as CatalogSourceRegistry,
        {} as CatalogService,
        {} as IntakeService,
        {} as InventoryService,
      );

      await expect(
        service.propose({ channelInstanceId: channelId, sourceKey: 'tcgcsv', setName: 'X' }),
      ).rejects.toThrow(/cannot list what it is already selling/i);
    });
  });

  describe('confirm', () => {
    it('creates the catalog item, SKU and allocation with the listing id', async () => {
      const result = await confirmEtb(20999);
      expect(result).toMatchObject({ linked: 1, unchanged: 0, problems: [] });

      const allocation = await prisma.channelAllocation.findFirstOrThrow({
        where: { channelInstanceId: channelId },
        include: { inventoryItem: { include: { sku: { include: { catalogItem: true } } } } },
      });

      // The whole point: the field that had no writer now has one.
      expect(allocation.externalListingId).toBe(ETB_GID);
      expect(allocation.price).toBe(20999);
      expect(allocation.mode).toBe('pooled');
      expect(allocation.inventoryItem.sku.catalogItem.name).toBe(
        '30th Celebration Elite Trainer Box',
      );
    });

    it('records the tcgplayer id, which is what every future listing is keyed on', async () => {
      await confirmEtb();

      const refs = await prisma.catalogExternalRef.findMany({ orderBy: { source: 'asc' } });
      expect(refs.map((r) => r.source)).toEqual(['tcgcsv', 'tcgplayer']);
      expect(refs.every((r) => r.externalId === '704143')).toBe(true);
    });

    it('links without crediting any stock', async () => {
      await confirmEtb();

      const item = await prisma.inventoryItem.findFirstOrThrow();
      // Linking is identity. Inventing a quantity would credit stock nobody counted.
      expect(item.quantityOnHand).toBe(0);

      // And no movement, because nothing moved — a delta-0 row would be a lie in
      // the audit trail.
      expect(await prisma.stockMovement.count()).toBe(0);
    });

    it('is a no-op when the same link is confirmed twice', async () => {
      await confirmEtb(20999);
      const again = await confirmEtb(20999);

      expect(again).toMatchObject({ linked: 0, unchanged: 1, problems: [] });
      expect(await prisma.channelAllocation.count()).toBe(1);
      expect(await prisma.inventoryItem.count()).toBe(1);
    });

    it('updates the price when re-confirmed with a different one', async () => {
      await confirmEtb(20999);
      const again = await confirmEtb(19999);

      expect(again.linked).toBe(1);
      const allocation = await prisma.channelAllocation.findFirstOrThrow();
      expect(allocation.price).toBe(19999);
    });

    it('refuses to point two inventory items at one channel listing', async () => {
      await confirmEtb();

      // Same Shopify variant, different product. Allowing it would leave two
      // inventory items pushing contradictory quantities to one variant.
      const result = await matching.confirm(channelId, [
        {
          externalListingId: ETB_GID,
          sourceKey: 'tcgcsv',
          sourceId: PIKACHU.sourceId,
          condition: 'NM',
        },
      ]);

      expect(result.linked).toBe(0);
      expect(result.problems[0]?.message).toMatch(/already linked to a different inventory item/i);
      expect(await prisma.channelAllocation.count()).toBe(1);
    });

    it('lands the good links even when one fails', async () => {
      const result = await matching.confirm(channelId, [
        {
          externalListingId: ETB_GID,
          sourceKey: 'tcgcsv',
          sourceId: 'does-not-exist',
          condition: 'SEALED',
        },
        {
          externalListingId: PIKACHU_GID,
          sourceKey: 'tcgcsv',
          sourceId: PIKACHU.sourceId,
          condition: 'NM',
          printing: 'FOIL',
        },
      ]);

      // A reviewer who confirmed forty matches should not lose thirty-nine to one
      // product deleted while they were reading.
      expect(result.linked).toBe(1);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]?.externalListingId).toBe(ETB_GID);

      const allocation = await prisma.channelAllocation.findFirstOrThrow();
      expect(allocation.externalListingId).toBe(PIKACHU_GID);
    });

    it('explains itself when the source cannot re-verify by id', async () => {
      canRefetch.mockReturnValue(false);

      const result = await matching.confirm(channelId, [
        {
          externalListingId: ETB_GID,
          sourceKey: 'tcgcsv',
          sourceId: 'unseen',
          condition: 'SEALED',
        },
      ]);

      // The client is never trusted for the product's name or ids, so a source
      // that cannot re-fetch cannot be confirmed against — and says so.
      expect(result.problems[0]?.message).toMatch(/cannot re-verify a product by id/i);
    });

    it('keeps the SKU dimensions it was given', async () => {
      await matching.confirm(channelId, [
        {
          externalListingId: PIKACHU_GID,
          sourceKey: 'tcgcsv',
          sourceId: PIKACHU.sourceId,
          condition: 'LP',
          printing: 'FOIL',
          language: 'JA',
        },
      ]);

      const sku = await prisma.sku.findFirstOrThrow();
      expect(sku).toMatchObject({ condition: 'LP', printing: 'FOIL', language: 'JA' });
    });
  });
});
