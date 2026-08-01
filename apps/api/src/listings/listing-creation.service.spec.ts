import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@hub/db';
import type { Connector, CreateListingRequest, CreateListingResult, Ctx } from '@hub/connector-sdk';
import { createScryfallSource } from '@hub/catalog-scryfall';
import { createTcgcsvSource } from '@hub/catalog-tcgcsv';
import {
  ListingCreationService,
  MAX_ITEMS,
  optionValueFor,
  titleFor,
} from './listing-creation.service';
import { InventoryService } from '../inventory/inventory.service';
import { HUB_SOURCE_KEY } from '../inventory/sku-code';
import type { ChannelContextFactory } from '../connectors/channel-context.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Creation against a real database.
 *
 * Everything worth pinning here is about not making a mess of somebody's
 * storefront: two conditions of one card must become one product, a re-run must
 * not create a second, and a run larger than a human will review must be
 * refused rather than trimmed. None of that is observable without the rows.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const PIKACHU_GID = 'gid://shopify/ProductVariant/1';

let prisma: PrismaClient;
let creation: ListingCreationService;
let channelId: string;
let createListing: ReturnType<typeof vi.fn>;
let capabilities: string[];

/** A catalog item with two conditions in stock, and no listings anywhere. */
async function seedCard(options: { refs?: Array<{ source: string; externalId: string }> } = {}) {
  const item = await prisma.catalogItem.create({
    data: {
      name: 'Pikachu ex',
      searchName: 'pikachu ex',
      game: 'Pokemon',
      setName: '30th Celebration',
      imageUrl: 'https://example.test/pikachu.jpg',
      externalRefs: {
        create: options.refs ?? [
          { source: 'tcgcsv', externalId: '696676' },
          { source: 'tcgplayer', externalId: '696676' },
        ],
      },
    },
  });

  const make = async (condition: string) => {
    const sku = await prisma.sku.create({
      data: { catalogItemId: item.id, condition, printing: 'NORMAL', language: 'EN' },
    });
    const inventory = await prisma.inventoryItem.create({
      data: { skuId: sku.id, quantityOnHand: 3 },
    });
    return { skuId: sku.id, inventoryItemId: inventory.id };
  };

  return { catalogItemId: item.id, nm: await make('NM'), lp: await make('LP') };
}

describeDb('ListingCreationService', () => {
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

    let next = 0;
    createListing = vi.fn(
      async (_ctx: Ctx, req: CreateListingRequest): Promise<CreateListingResult> => ({
        externalListingId: req.siblingListingId
          ? `gid://shopify/ProductVariant/v${++next}`
          : `gid://shopify/ProductVariant/p${++next}`,
        createdProduct: !req.siblingListingId,
        alreadyExisted: false,
      }),
    );

    capabilities = ['listing.create', 'listing.quantity'];

    const channels = {
      resolve: vi.fn(async () => ({
        connector: {
          key: 'shopify',
          displayName: 'Shopify',
          get capabilities() {
            return capabilities;
          },
          createListing,
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

    creation = new ListingCreationService(
      prisma as unknown as PrismaService,
      channels,
      new InventoryService(prisma as unknown as PrismaService),
    );
  });

  const create = (inventoryItemIds: string[], rest: Record<string, unknown> = {}) =>
    creation.create({ channelInstanceId: channelId, inventoryItemIds, ...rest });

  it('creates a draft product and links the allocation to what came back', async () => {
    const card = await seedCard();

    const result = await create([card.nm.inventoryItemId]);

    expect(result.problems).toEqual([]);
    expect(result.listings[0]).toMatchObject({
      outcome: 'created-product',
      sku: 'tcgcsv:696676:NM:NORMAL:EN',
      externalListingId: 'gid://shopify/ProductVariant/p1',
    });

    const allocation = await prisma.channelAllocation.findFirst({
      where: { channelInstanceId: channelId },
    });
    expect(allocation?.externalListingId).toBe('gid://shopify/ProductVariant/p1');
    expect(allocation?.inventoryItemId).toBe(card.nm.inventoryItemId);
    // Creation sets no quantity: stock reaches the channel through the normal
    // push path, so exactly one code path writes a platform's numbers (rule 5).
    expect(allocation?.listedQuantity).toBe(0);
  });

  it('sends the title, image and option value the ledger implies', async () => {
    const card = await seedCard();

    await create([card.nm.inventoryItemId]);

    expect(createListing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Pikachu ex',
        imageUrl: 'https://example.test/pikachu.jpg',
        optionName: 'Condition',
        optionValue: 'Near Mint',
      }),
    );
  });

  /**
   * The core's whole grouping decision. Two conditions of one card are one
   * product with two variants, so the second must name the first's listing —
   * the connector resolves the product from it, because the core stores no
   * product ids.
   */
  it('makes the second condition a variant of the sibling already listed', async () => {
    const card = await seedCard();

    await create([card.nm.inventoryItemId]);
    const second = await create([card.lp.inventoryItemId]);

    expect(createListing).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        sku: 'tcgcsv:696676:LP:NORMAL:EN',
        siblingListingId: 'gid://shopify/ProductVariant/p1',
      }),
    );
    expect(second.listings[0]?.outcome).toBe('added-variant');
  });

  /**
   * The same grouping, within one run. It works because the run is sequential
   * and the allocation is recorded before the next item is prepared — there is
   * no in-run bookkeeping to get out of step with the database. Two products
   * for one card is the failure customers see.
   */
  it('groups two conditions selected together into one product', async () => {
    const card = await seedCard();

    const result = await create([card.nm.inventoryItemId, card.lp.inventoryItemId]);

    expect(result.listings.map((l) => l.outcome)).toEqual(['created-product', 'added-variant']);
    expect(createListing.mock.calls[0]?.[1].siblingListingId).toBeUndefined();
    expect(createListing.mock.calls[1]?.[1].siblingListingId).toBe(
      'gid://shopify/ProductVariant/p1',
    );
  });

  /**
   * Every sealed product the operator already sells is a single-variant
   * "Default Title". A `Condition: Unopened` option on a booster box is a
   * choice with one answer put in front of a customer.
   */
  it('gives sealed product no condition option', async () => {
    const card = await seedCard();
    const sealed = await prisma.sku.create({
      data: {
        catalogItemId: card.catalogItemId,
        condition: 'SEALED',
        printing: 'NORMAL',
        language: 'EN',
      },
    });
    const item = await prisma.inventoryItem.create({
      data: { skuId: sealed.id, quantityOnHand: 1 },
    });

    await create([item.id]);

    const sent = createListing.mock.calls[0]?.[1];
    expect(sent.optionName).toBeUndefined();
    expect(sent.optionValue).toBeUndefined();
  });

  /**
   * And it follows: something with no option cannot be a variant of anything.
   * Adding one to a product that has only "Default Title" would be a second
   * variant with nothing to tell it apart.
   */
  it('never makes sealed product a variant of a sibling', async () => {
    const card = await seedCard();
    // The Near Mint single is listed first, so a sibling genuinely exists.
    await create([card.nm.inventoryItemId]);

    const sealed = await prisma.sku.create({
      data: {
        catalogItemId: card.catalogItemId,
        condition: 'SEALED',
        printing: 'NORMAL',
        language: 'EN',
      },
    });
    const item = await prisma.inventoryItem.create({
      data: { skuId: sealed.id, quantityOnHand: 1 },
    });

    const result = await create([item.id]);

    expect(createListing.mock.calls[1]?.[1].siblingListingId).toBeUndefined();
    expect(result.listings[0]?.outcome).toBe('created-product');
  });

  /**
   * "Not applicable" is what a binder, a playmat or a Funko Pop has for a
   * condition, and offering it as a choice is the sealed silliness one step
   * further on. Non-TCG goods are already in the ledger — the operator's
   * TCGPlayer export carries sleeves, deck boxes and playmats — so this is a
   * live path, not a hypothetical.
   */
  it('gives an item with no applicable condition no option either', async () => {
    const card = await seedCard();
    const na = await prisma.sku.create({
      data: {
        catalogItemId: card.catalogItemId,
        condition: 'NA',
        printing: 'NORMAL',
        language: 'EN',
      },
    });
    const item = await prisma.inventoryItem.create({ data: { skuId: na.id, quantityOnHand: 1 } });

    await create([item.id]);

    const sent = createListing.mock.calls[0]?.[1];
    expect(sent.optionName).toBeUndefined();
    // And it would otherwise have read "Condition: NA" on a storefront.
    expect(sent.optionValue).toBeUndefined();
  });

  it('still gives singles their condition option', async () => {
    const card = await seedCard();

    await create([card.nm.inventoryItemId]);

    expect(createListing.mock.calls[0]?.[1]).toMatchObject({
      optionName: 'Condition',
      optionValue: 'Near Mint',
    });
  });

  it('does not call the channel for an item it already drives a listing for', async () => {
    const card = await seedCard();
    await prisma.channelAllocation.create({
      data: {
        inventoryItemId: card.nm.inventoryItemId,
        channelInstanceId: channelId,
        externalListingId: PIKACHU_GID,
      },
    });

    const result = await create([card.nm.inventoryItemId]);

    expect(createListing).not.toHaveBeenCalled();
    expect(result.listings[0]).toMatchObject({
      outcome: 'already-linked',
      externalListingId: PIKACHU_GID,
    });
  });

  /**
   * "Some won't be listed on TCGPlayer" — the operator. A card no catalogue
   * carries still needs a SKU, so it gets one in the hub's own namespace keyed
   * on the `Sku` id, which cannot collide with a catalogue product id.
   */
  it('creates for a card with no external refs at all, under the hub namespace', async () => {
    const card = await seedCard({ refs: [] });

    const result = await create([card.nm.inventoryItemId]);

    expect(result.problems).toEqual([]);
    expect(result.listings[0]?.sku).toBe(`${HUB_SOURCE_KEY}:${card.nm.skuId}:NM:NORMAL:EN`);
  });

  /**
   * The code must carry the same attribution a later proposal run presents the
   * item under, or the matcher will not recognise its own writing. `tcgcsv`
   * before `tcgplayer` is `pickAttribution`'s order, and this fails if creation
   * grows a second copy of that choice.
   */
  it('writes the code under the attribution the matcher will look for', async () => {
    const card = await seedCard({
      refs: [
        { source: 'tcgplayer', externalId: '111' },
        { source: 'tcgcsv', externalId: '222' },
      ],
    });

    const result = await create([card.nm.inventoryItemId]);

    expect(result.listings[0]?.sku).toBe('tcgcsv:222:NM:NORMAL:EN');
  });

  it('applies operator tags verbatim and sends none when there are none', async () => {
    const card = await seedCard();

    await create([card.nm.inventoryItemId], { tags: ['Pokémon', ' SV04 Paradox Rift '] });
    expect(createListing.mock.calls[0]?.[1].tags).toEqual(['Pokémon', 'SV04 Paradox Rift']);

    await create([card.lp.inventoryItemId]);
    // Absent rather than empty: the hub has no tag of its own to fall back on,
    // and a derived one puts the product in no collection at all.
    expect(createListing.mock.calls[1]?.[1].tags).toBeUndefined();
  });

  it('sends a price the allocation already carries, and none when it has one no more', async () => {
    const card = await seedCard();
    await prisma.channelAllocation.create({
      data: { inventoryItemId: card.nm.inventoryItemId, channelInstanceId: channelId, price: 1299 },
    });

    await create([card.nm.inventoryItemId, card.lp.inventoryItemId]);

    expect(createListing.mock.calls[0]?.[1].price).toBe(1299);
    expect(createListing.mock.calls[1]?.[1].price).toBeUndefined();
  });

  /**
   * One listing driven by two inventory items means two of them pushing
   * contradictory quantities at one variant. `applyLink` refuses it; so does
   * this, and it must not quietly move the existing allocation.
   */
  it('refuses to take a listing another inventory item already drives', async () => {
    const card = await seedCard();
    await prisma.channelAllocation.create({
      data: {
        inventoryItemId: card.lp.inventoryItemId,
        channelInstanceId: channelId,
        externalListingId: PIKACHU_GID,
      },
    });

    // What `alreadyExisted` looks like when the SKU is already sitting on a
    // listing this hub drives from another item — a hand-edited seller SKU does
    // it, and so does a code written before an allocation was moved.
    createListing.mockResolvedValue({
      externalListingId: PIKACHU_GID,
      createdProduct: false,
      alreadyExisted: true,
    });

    const result = await create([card.nm.inventoryItemId]);

    expect(result.listings).toEqual([]);
    expect(result.problems[0]?.message).toContain('driven by another inventory item');

    // The allocation holding it is untouched rather than silently moved, which
    // is the failure `applyLink` was fixed for.
    const held = await prisma.channelAllocation.findFirst({
      where: { channelInstanceId: channelId, externalListingId: PIKACHU_GID },
    });
    expect(held?.inventoryItemId).toBe(card.lp.inventoryItemId);
    expect(await prisma.channelAllocation.count({ where: { channelInstanceId: channelId } })).toBe(
      1,
    );
  });

  it('reports one failure and still lands the rest', async () => {
    const card = await seedCard();
    createListing.mockRejectedValueOnce(new Error('Shopify said no'));

    const result = await create([card.nm.inventoryItemId, card.lp.inventoryItemId]);

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.name).toBe('Pikachu ex');
    expect(result.listings).toHaveLength(1);
    expect(await prisma.channelAllocation.count({ where: { channelInstanceId: channelId } })).toBe(
      1,
    );
  });

  it('refuses a run larger than one an operator would review, before calling the channel', async () => {
    const ids = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `item-${i}`);

    await expect(create(ids)).rejects.toThrow(/at most/);
    expect(createListing).not.toHaveBeenCalled();
  });

  it('refuses a connector that cannot create, rather than silently doing nothing', async () => {
    capabilities = ['listing.quantity'];
    const card = await seedCard();

    await expect(create([card.nm.inventoryItemId])).rejects.toThrow(/cannot create listings/);
  });
});

describe('titleFor', () => {
  /**
   * The catalogue's name and nothing else, on the operator's instruction. An
   * earlier version appended the set and produced "Phantasmal Flames Pokemon
   * Center Elite Trainer Box (Exclusive) - ME02: Phantasmal Flames", which is
   * redundant because a sealed product's name already carries its set.
   */
  it('is the catalogue name, with nothing composed onto it', () => {
    expect(
      titleFor({ name: 'Phantasmal Flames Pokemon Center Elite Trainer Box (Exclusive)' }),
    ).toBe('Phantasmal Flames Pokemon Center Elite Trainer Box (Exclusive)');
    expect(titleFor({ name: 'Charizard ex' })).toBe('Charizard ex');
  });

  it('trims, because a stray space becomes a storefront title', () => {
    expect(titleFor({ name: '  Pikachu ex  ' })).toBe('Pikachu ex');
  });
});

describe('optionValueFor', () => {
  /**
   * Shopify titles a variant "<product> - <option value>", and
   * `deriveSkuDimensions` parses exactly that grammar back. So the option value
   * is TCGPlayer's spelling on purpose: a listing whose SKU field is later
   * cleared by hand still says what condition it is, in a vocabulary this
   * repository can already read.
   */
  it('uses the condition spelling the matcher can read back', () => {
    expect(optionValueFor({ condition: 'NM', printing: 'NORMAL', language: 'EN' })).toBe(
      'Near Mint',
    );
    expect(
      optionValueFor({ condition: 'NM', printing: '1ST_EDITION_HOLOFOIL', language: 'JA' }),
    ).toBe('Near Mint 1st Edition Holofoil - Japanese');
  });

  it('falls back to the raw tokens for a SKU TCGPlayer has no spelling for', () => {
    // `NA` is in the core's vocabulary and not in TCGPlayer's, so formatting
    // fails rather than approximating — and creation must still produce a
    // unique option value.
    expect(optionValueFor({ condition: 'NA', printing: 'ETCHED', language: 'EN' })).toBe(
      'NA ETCHED',
    );
  });
});

/**
 * The hub namespace is reserved. A catalog source registering under it would
 * make `hub:<uuid>` codes look resolvable and start proposing them.
 */
describe('the hub SKU namespace', () => {
  it('is claimed by no bundled catalog source', () => {
    const keys = [createScryfallSource().key, createTcgcsvSource().key];
    expect(keys).not.toContain(HUB_SOURCE_KEY);
  });
});
