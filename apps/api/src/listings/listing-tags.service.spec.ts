import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import { ListingTagsService } from './listing-tags.service';
import { encodeListingDefaults } from '../channels/listing-defaults';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChannelContextFactory } from '../connectors/channel-context.service';

/**
 * The back-fill's own judgement, with the connector faked at its seam.
 *
 * What is worth pinning is what the service decides, not what Shopify does:
 * which listings are offered, that the tags come from the rules rather than
 * anything stored on the allocation, that a listing needing nothing is
 * reported as unchanged rather than as work, and that a run is refused
 * outright when there are no rules — the case where a naive implementation
 * would happily "apply" nothing to everything.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let channelId: string;

/** Records what the connector was asked to add, and reports it back. */
function fakeConnector(alreadyOn: Record<string, string[]> = {}) {
  const calls: Array<{ externalListingId: string; addTags: readonly string[] }> = [];
  const updateListingAttributes = vi.fn(
    async (_ctx: unknown, req: { externalListingId: string; addTags: readonly string[] }) => {
      calls.push(req);
      const have = new Set(alreadyOn[req.externalListingId] ?? []);
      const added = req.addTags.filter((tag) => !have.has(tag));
      return { added, tags: [...have, ...added] };
    },
  );

  const connector = {
    key: 'shopify',
    displayName: 'Shopify',
    capabilities: ['listing.attributes'],
    rateLimit: { requestsPerSecond: 100, burst: 100 },
    updateListingAttributes,
  };

  const channels = {
    resolve: async () => ({ connector, ctx: {}, displayName: 'Test Store' }),
  } as unknown as ChannelContextFactory;

  return { channels, calls };
}

async function seedListing(options: {
  name: string;
  game: string | null;
  setName: string | null;
  condition: string;
  externalListingId: string | null;
}) {
  const catalogItem = await prisma.catalogItem.create({
    data: {
      name: options.name,
      searchName: options.name.toLowerCase(),
      game: options.game,
      setName: options.setName,
    },
  });
  const sku = await prisma.sku.create({
    data: {
      catalogItemId: catalogItem.id,
      condition: options.condition,
      printing: 'NORMAL',
      language: 'EN',
    },
  });
  const item = await prisma.inventoryItem.create({ data: { skuId: sku.id, quantityOnHand: 1 } });
  await prisma.channelAllocation.create({
    data: {
      inventoryItemId: item.id,
      channelInstanceId: channelId,
      mode: 'pooled',
      externalListingId: options.externalListingId,
    },
  });
  return item.id;
}

async function setRules(rules: Array<{ match: string; value: string; tag: string }>) {
  await prisma.channelInstance.update({
    where: { id: channelId },
    data: {
      listingDefaults: encodeListingDefaults({
        tagRules: rules as never,
      }),
    },
  });
}

describeDb('ListingTagsService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.channelAllocation.deleteMany();
    await prisma.inventoryItem.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.catalogItem.deleteMany();
    await prisma.channelInstance.deleteMany();

    const channel = await prisma.channelInstance.create({
      data: { connectorKey: 'shopify', displayName: 'Test Store', config: '{}' },
    });
    channelId = channel.id;
  });

  function build(alreadyOn: Record<string, string[]> = {}) {
    const { channels, calls } = fakeConnector(alreadyOn);
    return {
      service: new ListingTagsService(prisma as unknown as PrismaService, channels),
      calls,
    };
  }

  it('offers linked listings with the tags their rules resolve to', async () => {
    await setRules([
      { match: 'game', value: 'Pokemon', tag: 'Pokémon' },
      { match: 'set', value: 'SV: 151', tag: 'SV 151' },
    ]);
    const id = await seedListing({
      name: 'Charizard ex',
      game: 'Pokemon',
      setName: 'SV: 151',
      condition: 'NM',
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    const { service } = build();
    const pending = await service.pending(channelId);

    expect(pending).toHaveLength(1);
    expect(pending[0]!.inventoryItemId).toBe(id);
    expect(pending[0]!.tags).toEqual(['Pokémon', 'SV 151']);
  });

  /** An unlinked allocation has no listing to tag, so it is not offered. */
  it('omits an unlinked allocation', async () => {
    await setRules([{ match: 'game', value: 'Pokemon', tag: 'Pokémon' }]);
    await seedListing({
      name: 'Pikachu',
      game: 'Pokemon',
      setName: null,
      condition: 'NM',
      externalListingId: null,
    });

    expect(await build().service.pending(channelId)).toEqual([]);
  });

  /**
   * A row offering nothing is noise on a screen whose job is to be picked
   * from — and applying it would be a storefront call that cannot change
   * anything.
   */
  it('omits a listing whose rules produce no tag', async () => {
    await setRules([{ match: 'game', value: 'Magic', tag: 'Magic: The Gathering' }]);
    await seedListing({
      name: 'Charizard ex',
      game: 'Pokemon',
      setName: null,
      condition: 'NM',
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    expect(await build().service.pending(channelId)).toEqual([]);
  });

  /**
   * Refused rather than answered with an empty list: "no rules" and "no
   * matching listings" are different problems with different fixes, and only
   * one of them is fixed on this screen.
   */
  it('refuses when the channel has no tag rules at all', async () => {
    await seedListing({
      name: 'Charizard ex',
      game: 'Pokemon',
      setName: null,
      condition: 'NM',
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    await expect(build().service.pending(channelId)).rejects.toThrow(/no tag rules/);
  });

  it('sends the resolved tags and reports what was added', async () => {
    await setRules([{ match: 'game', value: 'Pokemon', tag: 'Pokémon' }]);
    const id = await seedListing({
      name: 'Charizard ex',
      game: 'Pokemon',
      setName: null,
      condition: 'NM',
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    const { service, calls } = build();
    const result = await service.apply(channelId, [id]);

    expect(calls).toEqual([
      { externalListingId: 'gid://shopify/ProductVariant/1', addTags: ['Pokémon'] },
    ]);
    expect(result.updated).toEqual([
      { inventoryItemId: id, name: 'Charizard ex', added: ['Pokémon'] },
    ]);
    expect(result.unchanged).toEqual([]);
  });

  /** A re-run must read as "nothing to do", never as work performed. */
  it('reports a listing that already carries every tag as unchanged', async () => {
    await setRules([{ match: 'game', value: 'Pokemon', tag: 'Pokémon' }]);
    const id = await seedListing({
      name: 'Charizard ex',
      game: 'Pokemon',
      setName: null,
      condition: 'NM',
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    const { service } = build({ 'gid://shopify/ProductVariant/1': ['Pokémon'] });
    const result = await service.apply(channelId, [id]);

    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([{ inventoryItemId: id, name: 'Charizard ex' }]);
  });

  it('reports an id that is not eligible rather than failing the batch', async () => {
    await setRules([{ match: 'game', value: 'Pokemon', tag: 'Pokémon' }]);
    const good = await seedListing({
      name: 'Charizard ex',
      game: 'Pokemon',
      setName: null,
      condition: 'NM',
      externalListingId: 'gid://shopify/ProductVariant/1',
    });

    const { service } = build();
    const result = await service.apply(channelId, [good, 'no-such-item']);

    expect(result.updated).toHaveLength(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.inventoryItemId).toBe('no-such-item');
  });
});
