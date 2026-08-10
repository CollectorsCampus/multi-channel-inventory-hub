import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { Connector, Ctx, UpdateListingImageRequest } from '@hub/connector-sdk';
import { ListingImagesService } from './listing-images.service';
import { MAX_ITEMS } from './listing-creation.service';
import type { ChannelContextFactory } from '../connectors/channel-context.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Image re-push against a real database.
 *
 * What is worth pinning is the boundary of the run: only linked singles with a
 * catalogue image are offered or acted on — a sealed listing's imagery is the
 * operator's own work and must be unreachable here — and one failure must not
 * take the batch down with it.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const IMAGE = 'https://tcgplayer-cdn.tcgplayer.com/product/1_in_1000x1000.jpg';

let prisma: PrismaClient;
let service: ListingImagesService;
let channelId: string;
let updateListingImage: ReturnType<typeof vi.fn>;
let capabilities: string[];

async function seed(options: {
  name: string;
  condition: string;
  imageUrl?: string | null;
  linked?: boolean;
}) {
  const item = await prisma.catalogItem.create({
    data: {
      name: options.name,
      searchName: options.name.toLowerCase(),
      game: 'Pokemon',
      setName: 'Test Set',
      imageUrl: options.imageUrl === undefined ? IMAGE : options.imageUrl,
    },
  });
  const sku = await prisma.sku.create({
    data: {
      catalogItemId: item.id,
      condition: options.condition,
      printing: 'NORMAL',
      language: 'EN',
    },
  });
  const inventory = await prisma.inventoryItem.create({
    data: { skuId: sku.id, quantityOnHand: 1 },
  });
  await prisma.channelAllocation.create({
    data: {
      inventoryItemId: inventory.id,
      channelInstanceId: channelId,
      mode: 'pooled',
      ...(options.linked === false
        ? {}
        : { externalListingId: `gid://shopify/ProductVariant/${inventory.id}` }),
    },
  });
  return { catalogItemId: item.id, inventoryItemId: inventory.id };
}

describeDb('ListingImagesService', () => {
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

    updateListingImage = vi.fn(async (_ctx: Ctx, _req: UpdateListingImageRequest) => {});
    capabilities = ['listing.image'];

    const channels = {
      resolve: vi.fn(async () => ({
        connector: {
          key: 'shopify',
          displayName: 'Shopify',
          get capabilities() {
            return capabilities;
          },
          updateListingImage,
        } as unknown as Connector,
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

    service = new ListingImagesService(prisma as unknown as PrismaService, channels);
  });

  describe('pending', () => {
    it('offers linked singles with a catalogue image, and nothing else', async () => {
      const single = await seed({ name: 'Pikachu ex', condition: 'NM' });
      await seed({ name: 'Booster Box', condition: 'SEALED' });
      await seed({ name: 'Playmat', condition: 'NA' });
      await seed({ name: 'Unlinked', condition: 'NM', linked: false });
      await seed({ name: 'No Image', condition: 'NM', imageUrl: null });

      const pending = await service.pending(channelId);

      expect(pending.map((p) => p.name)).toEqual(['Pikachu ex']);
      expect(pending[0]).toMatchObject({
        inventoryItemId: single.inventoryItemId,
        condition: 'NM',
      });
    });

    it('is refused for a connector without the capability', async () => {
      capabilities = ['listing.create'];
      await expect(service.pending(channelId)).rejects.toThrow(/cannot update/i);
    });
  });

  describe('push', () => {
    it('replaces the image of each selected listing with the catalogue’s current one', async () => {
      const a = await seed({ name: 'Pikachu ex', condition: 'NM' });
      const b = await seed({ name: 'Charizard ex', condition: 'LP' });

      const result = await service.push(channelId, [a.inventoryItemId, b.inventoryItemId]);

      expect(result.problems).toEqual([]);
      expect(result.updated.map((u) => u.name).sort()).toEqual(['Charizard ex', 'Pikachu ex']);
      expect(updateListingImage).toHaveBeenCalledTimes(2);
      expect(updateListingImage.mock.calls[0]![1]).toMatchObject({ imageUrl: IMAGE });
    });

    it('sends the catalogue’s image at push time, not the screen’s snapshot', async () => {
      const card = await seed({ name: 'Pikachu ex', condition: 'NM' });
      // The catalogue improved between the screen loading and the operator
      // clicking — the point of the run is the current image.
      await prisma.catalogItem.update({
        where: { id: card.catalogItemId },
        data: { imageUrl: 'https://example.test/better.jpg' },
      });

      await service.push(channelId, [card.inventoryItemId]);

      expect(updateListingImage.mock.calls[0]![1]).toMatchObject({
        imageUrl: 'https://example.test/better.jpg',
      });
    });

    it('reports a sealed selection as a problem and still lands the rest', async () => {
      const single = await seed({ name: 'Pikachu ex', condition: 'NM' });
      const sealed = await seed({ name: 'Booster Box', condition: 'SEALED' });

      const result = await service.push(channelId, [
        sealed.inventoryItemId,
        single.inventoryItemId,
      ]);

      expect(result.updated.map((u) => u.name)).toEqual(['Pikachu ex']);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!.message).toMatch(/linked single/i);
    });

    it('reports a connector failure per item and continues', async () => {
      const a = await seed({ name: 'Pikachu ex', condition: 'NM' });
      const b = await seed({ name: 'Charizard ex', condition: 'LP' });
      updateListingImage.mockRejectedValueOnce(new Error('Image could not be downloaded.'));

      const result = await service.push(channelId, [a.inventoryItemId, b.inventoryItemId]);

      expect(result.updated).toHaveLength(1);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]!.message).toMatch(/could not be downloaded/);
    });

    it('refuses an oversized run rather than truncating it', async () => {
      const ids = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `id-${i}`);
      await expect(service.push(channelId, ids)).rejects.toThrow(/at most/i);
      expect(updateListingImage).not.toHaveBeenCalled();
    });

    it('refuses an empty selection', async () => {
      await expect(service.push(channelId, [])).rejects.toThrow(/at least one/i);
    });
  });
});
