import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  hasCapability,
  type CreateListingRequest,
  type ListingMetafield,
  type ListingMetafieldDefinition,
} from '@hub/connector-sdk';
import { formatCondition } from '@hub/connector-tcgplayer';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory, type ResolvedChannel } from '../connectors/channel-context.service';
import { pickAttribution } from '../catalog/catalog.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
import { InventoryService } from '../inventory/inventory.service';
import { IntakeService, type IntakeRequest, type IntakeResult } from '../inventory/intake.service';
import { encodeSkuCode, HUB_SOURCE_KEY } from '../inventory/sku-code';
import {
  applyListingDefaults,
  parseListingDefaults,
  resolveTags,
  type ChannelListingDefaults,
} from '../channels/listing-defaults';

/**
 * Putting a card the store does not carry onto the storefront.
 *
 * The core half of `listing.create`. The connector knows how to make a product;
 * this decides *which* products, what they are called, and which of them are
 * really variants of one another — all of which are catalogue judgements, and
 * therefore the core's (rule 6).
 *
 * ## Selected, never automatic
 *
 * The operator's own constraint, and the first thing to preserve if this is
 * ever extended: it "probably shouldn't be automatic to create everything that
 * is in say your tcgplayer export". A 1,333-row import must not become 1,333
 * storefront products. So this takes an explicit list of inventory items and is
 * reachable from nothing else — not intake, not a push, not a queue.
 *
 * {@link MAX_ITEMS} is the same argument made structural. A run larger than
 * that is refused rather than truncated, because a truncated run of storefront
 * creations is indistinguishable from a complete one until a customer finds the
 * gap.
 *
 * ## What the hub is entitled to invent: as close to nothing as possible
 *
 * Title, image, condition label and SKU code are all *arrangements of stored
 * facts* rather than inventions. Tags and vendor come from the operator and are
 * applied verbatim — never derived, because on this store all 23 collections
 * are smart collections keyed on one tag equality rule, catalogue names are not
 * the store's tags (`Pokemon` against `Pokémon`), and a tag the hub guessed
 * puts the product in no collection at all: present in the admin, invisible in
 * the shop, reported by nothing.
 *
 * ## Order of operations, and why it is the opposite of matching
 *
 * `MatchingService.confirm` records the link locally *before* touching the
 * channel, so a failure cannot leave a storefront stamped with an id the hub
 * has no allocation for. Creation cannot do that: the id does not exist until
 * the platform makes it. So the connector is called first, and a local failure
 * afterwards leaves a draft product carrying our SKU with no allocation here.
 *
 * That is recoverable precisely because `createListing` is idempotent on the
 * SKU: re-running the same selection finds the listing, returns it untouched,
 * and links it. It is the reason the SKU code is built before anything is
 * created rather than after.
 */

/**
 * Most items one run may create.
 *
 * A number a human could review afterwards, not a technical limit. Shopify's
 * 2/s allowance means fifty creations already take half a minute of an
 * operator's attention.
 */
export const MAX_ITEMS = 50;

/** What distinguishes variants of a product, when the caller names nothing. */
export const DEFAULT_OPTION_NAME = 'Condition';

/**
 * Conditions that are not a variant axis, so get no option and no sibling.
 *
 * A `Condition` option is worth showing a customer only where condition is a
 * real choice, which is singles. `SEALED` has one answer — the operator's call,
 * and every sealed product their store already sells is a single-variant
 * "Default Title". `NA` follows by its own definition: "not applicable" is what
 * a binder, a playmat or a Funko Pop has, and offering it as a choice is the
 * same silliness one step further on.
 *
 * Note what this is *not* saying: that such products have no variants. Their
 * store has 69 multi-variant products whose axis is `Promo`, `Deck`, `Colour`,
 * `Scene` or `Type` — none of which the hub models or could invent. Those are
 * mapped by hand through `/match`, which is a different path entirely.
 */
export const UNVARIED_CONDITIONS: readonly string[] = ['SEALED', 'NA'];

export interface CreateListingsRequest {
  channelInstanceId: string;
  /** Ledger items the operator selected. Never derived from a filter. */
  inventoryItemIds: readonly string[];
  /**
   * Applied verbatim to products this run creates, or none when empty.
   *
   * Not applied to a variant added to an existing product: tags are a product
   * attribute on every platform modelling them, and rewriting the tags of a
   * product the operator already curated is not something creating a variant
   * should do.
   */
  tags?: readonly string[];
  /**
   * Custom fields the operator picked, applied verbatim to created products.
   *
   * Per run rather than per card, and that is honest rather than lazy: the
   * values are opaque ids in the channel's own vocabulary, so the core cannot
   * derive one per card even in principle — `custom.set` on this store is a
   * metaobject named `ME02 Phantasmal Flames`, while the catalogue calls the
   * same set `ME02: Phantasmal Flames`. A run is therefore one set's worth of
   * cards, the same scope a proposal run has.
   */
  metafields?: readonly ListingMetafield[];
  /**
   * The channel's own product classification, applied verbatim.
   *
   * Usually not a free choice: most of this store's metafield definitions are
   * *conditional*, restricted to a category, so a product created without one
   * has every metafield rejected. `ListingMetafieldDefinition.requiresCategory`
   * carries the answer, and the screen fills this in from the fields chosen.
   */
  category?: string;
  vendor?: string;
  optionName?: string;
  /**
   * What to sell these for, in cents. Applied to the allocation and sent at
   * creation.
   *
   * **One price for the whole run, so it is only meaningful for a run of one** —
   * which is why nothing but `intakeAndList` sets it. Fifty cards do not share
   * a price, and `/list` deliberately leaves this alone so each keeps whatever
   * its allocation already held.
   *
   * Absent leaves existing prices untouched, so re-running a selection never
   * silently reprices a card the operator has adjusted by hand.
   */
  price?: number;
  actorUserId?: string;
}

export type CreateListingOutcome =
  /** A new product, with this SKU as its first variant. */
  | 'created-product'
  /** A variant added to a product a sibling SKU already drives. */
  | 'added-variant'
  /** The channel already had this SKU; its listing was linked, not rewritten. */
  | 'already-existed'
  /** This hub already drives a listing for the item. The channel was not called. */
  | 'already-linked';

export interface CreatedListing {
  inventoryItemId: string;
  name: string;
  /** The code written into the channel's seller-SKU field. */
  sku: string;
  externalListingId: string;
  outcome: CreateListingOutcome;
}

export interface CreateListingsResult {
  listings: CreatedListing[];
  problems: Array<{ inventoryItemId: string; name?: string; message: string }>;
}

type SelectedItem = {
  id: string;
  allocations: Array<{ externalListingId: string | null; price: number | null; mode: string }>;
  sku: {
    id: string;
    condition: string;
    printing: string;
    language: string;
    catalogItem: {
      id: string;
      name: string;
      /** Read for tag rules, which map a catalogue game onto the store's word for it. */
      game: string | null;
      setName: string | null;
      imageUrl: string | null;
      externalRefs: Array<{ source: string; externalId: string }>;
    };
  };
};

@Injectable()
export class ListingCreationService {
  private readonly logger = new Logger(ListingCreationService.name);
  /**
   * The connector's own declared limit, as matching and reconciliation do it.
   * Shopify allows 2/s, and creating a product costs two or three calls, so a
   * run of fifty would otherwise burst straight through the allowance.
   */
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
    private readonly inventory: InventoryService,
    private readonly intakeService: IntakeService,
  ) {}

  /**
   * The tag vocabulary the channel already uses.
   *
   * Read-only, and its only purpose is to stop the operator inventing a tag.
   */
  async listTags(channelInstanceId: string, limit?: number): Promise<string[]> {
    const { connector, ctx, displayName } = await this.channels.resolve(channelInstanceId);

    if (!hasCapability(connector.capabilities, 'listing.tags')) {
      throw new BadRequestException(
        `${connector.displayName} does not report the tags "${displayName}" uses.`,
      );
    }

    return connector.listTags!(ctx, limit === undefined ? {} : { limit });
  }

  /**
   * The custom fields this channel models, and what each accepts.
   *
   * Read-only, and its only purpose is the same as {@link listTags}: the
   * operator picks a value the channel already knows, and the hub never derives
   * one. Here it could not derive one even if it wanted to — the values are
   * opaque ids that mean something only inside that shop.
   */
  async listMetafields(
    channelInstanceId: string,
    limit?: number,
  ): Promise<ListingMetafieldDefinition[]> {
    const { connector, ctx, displayName } = await this.channels.resolve(channelInstanceId);

    if (!hasCapability(connector.capabilities, 'listing.metafields')) {
      throw new BadRequestException(
        `${connector.displayName} does not report the custom fields "${displayName}" models.`,
      );
    }

    return connector.listMetafields!(ctx, limit === undefined ? {} : { limit });
  }

  async create(request: CreateListingsRequest): Promise<CreateListingsResult> {
    const ids = [...new Set(request.inventoryItemIds)];

    if (ids.length === 0) {
      throw new BadRequestException('Select at least one inventory item to list.');
    }
    if (ids.length > MAX_ITEMS) {
      // Refused, not truncated: a partial run of storefront creations looks
      // exactly like a complete one afterwards.
      throw new BadRequestException(
        `${ids.length} items is more than one run may create. Select at most ${MAX_ITEMS}.`,
      );
    }

    const { connector, ctx, displayName } = await this.channels.resolve(request.channelInstanceId, {
      requireEnabled: true,
    });

    if (!hasCapability(connector.capabilities, 'listing.create')) {
      throw new BadRequestException(
        `"${displayName}" cannot create listings: ${connector.displayName} has no way to bring ` +
          `one into existence. Create it on the platform, then link it from the match screen.`,
      );
    }

    // What the channel has declared, for anything this run did not say. Applied
    // here rather than at the controller so every caller gets it — the /list
    // screen, a single item listed from its own page, and intake — and so there
    // is one place that decides what "the caller did not say" means.
    //
    // Only `undefined` falls back. An explicit empty list is this run's answer
    // and must reach the channel unchanged; silently refilling it would make
    // "no tags, just this once" inexpressible.
    const defaults = await this.channelDefaults(request.channelInstanceId);
    const withDefaults = applyListingDefaults(request, defaults);

    const items = await this.loadItems(ids, request.channelInstanceId);
    const optionName = withDefaults.optionName?.trim() || DEFAULT_OPTION_NAME;

    /**
     * Tags are the one field that depends on *which card* this is, so they are
     * resolved per item rather than once per run.
     *
     * A store's tags are `Pokémon`, `SV04 Paradox Rift` and `Elite Trainer
     * Box` — all three differ per card, so a single list per run is only ever
     * right for a single-game, single-set batch. The channel's rules map facts
     * the ledger already holds onto tags the operator chose.
     *
     * A run may still override them wholesale, and that wins outright: it is
     * how `/list` says "this whole batch is one set" and how an explicit empty
     * list says "no tags this time".
     */
    const runTags =
      request.tags === undefined
        ? null
        : request.tags.map((tag) => tag.trim()).filter((tag) => tag !== '');

    const vendor = withDefaults.vendor?.trim();
    // Carried through untouched. The core does not know what a value means —
    // on Shopify it is a metaobject id — so validating or normalising it here
    // would be the core inventing an opinion it cannot hold.
    const metafields = withDefaults.metafields ?? [];
    const category = withDefaults.category?.trim();

    const result: CreateListingsResult = { listings: [], problems: [] };

    // Sequential, and that is what makes grouping work within one run as well
    // as across runs: selecting Near Mint and Lightly Played of one card
    // creates the product for the first and finds it as a sibling for the
    // second, because the allocation is recorded before the next item is
    // prepared. No in-run bookkeeping, deliberately — a listing this hub does
    // not yet drive is not a sibling, and a second copy of "which product is
    // this" is how the two answers start to disagree.
    //
    // It is also the same reason `confirm` is sequential: `upsertAllocation`
    // takes the optimistic-locking path, and a platform's rate limit is shared.
    for (const id of ids) {
      const item = items.get(id);
      if (!item) {
        result.problems.push({ inventoryItemId: id, message: 'No such inventory item.' });
        continue;
      }

      const name = item.sku.catalogItem.name;
      const tags = runTags ?? resolveTags(defaults, item.sku.catalogItem);

      try {
        result.listings.push(
          await this.createOne(request.channelInstanceId, { connector, ctx }, item, {
            optionName,
            tags,
            metafields,
            ...(category ? { category } : {}),
            ...(vendor ? { vendor } : {}),
            ...(request.price !== undefined ? { price: request.price } : {}),
          }),
        );
      } catch (error) {
        result.problems.push({
          inventoryItemId: id,
          name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const created = result.listings.filter((l) => l.outcome === 'created-product').length;
    const variants = result.listings.filter((l) => l.outcome === 'added-variant').length;

    this.logger.log(
      `Created ${created} product(s) and ${variants} variant(s) on "${displayName}" by ` +
        `${request.actorUserId ?? 'unknown'} (${result.listings.length - created - variants} ` +
        `already there, ${result.problems.length} problem(s)).`,
    );

    return result;
  }

  /**
   * Take stock in and put it on this channel, in one call.
   *
   * The everyday path for a seller adding cards one at a time: without it,
   * getting a card from "in the box" to "on the storefront" means intake on one
   * screen and a selection on another, for every card.
   *
   * ## This does not make creation automatic
   *
   * The constraint it preserves is the one that matters — "a 1,333-row import
   * must not become 1,333 storefront products". This is still one item, named
   * by a caller who asked for it. **Bulk file imports do not come through
   * here**, and must not be routed through it: `ChannelFilesService` writes a
   * `WebhookEvent` and the inbound worker applies it, which is a different path
   * on purpose.
   *
   * ## Intake wins
   *
   * The two halves are deliberately not atomic, and the order is deliberate:
   * the stock is recorded first and a listing failure is **reported, never
   * rolled back**. A card that is physically on the shelf is a fact; whether
   * Shopify accepted a draft product is not, and unwinding a real stock
   * movement because a storefront was briefly unreachable would make the ledger
   * lie about the shelf. The operator can retry the listing from the item, and
   * `createListing` being idempotent on the SKU code is what makes that safe.
   */
  async intakeAndList(
    request: IntakeRequest & {
      channelInstanceId: string;
      tags?: readonly string[];
      metafields?: readonly ListingMetafield[];
      category?: string;
      vendor?: string;
      optionName?: string;
      /**
       * What to sell it for, in cents.
       *
       * Distinct from `costBasis`, which the same form also collects: that is
       * what the card cost to buy and belongs to the ledger, this is what a
       * customer pays and belongs to the channel. Conflating them is an easy
       * mistake to make and an expensive one to notice.
       */
      price?: number;
    },
  ): Promise<{ intake: IntakeResult; listing: CreateListingsResult }> {
    const {
      channelInstanceId,
      tags,
      metafields,
      category,
      vendor,
      optionName,
      price,
      ...intakeRequest
    } = request;

    // Deliberately not caught: with no stock recorded there is nothing to list,
    // and reporting a listing problem for a card that was never taken in would
    // describe a failure that did not happen.
    const intake = await this.intakeService.intake(intakeRequest);

    try {
      const listing = await this.create({
        channelInstanceId,
        inventoryItemIds: [intake.ledger.inventoryItemId],
        ...(tags !== undefined ? { tags } : {}),
        ...(metafields !== undefined ? { metafields } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(vendor !== undefined ? { vendor } : {}),
        ...(optionName !== undefined ? { optionName } : {}),
        // A run of one, which is the only shape a single price makes sense in.
        ...(price !== undefined ? { price } : {}),
        ...(intakeRequest.actorUserId !== undefined
          ? { actorUserId: intakeRequest.actorUserId }
          : {}),
      });

      return { intake, listing };
    } catch (error) {
      // A whole-run failure — the channel is disabled, the connector cannot
      // create, the run was refused — arrives as an exception rather than a
      // per-item problem. Reported in the same shape so one caller handles both,
      // and the intake above still stands.
      return {
        intake,
        listing: {
          listings: [],
          problems: [
            {
              inventoryItemId: intake.ledger.inventoryItemId,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      };
    }
  }

  // -------------------------------------------------------------------------

  /**
   * What this channel says a created product should carry.
   *
   * A missing row yields no defaults rather than throwing: `resolve` above has
   * already established the channel exists, so the only way to get here without
   * one is a deletion mid-request, and failing the whole run for that would be
   * a worse answer than creating with exactly what the caller asked for.
   */
  private async channelDefaults(channelInstanceId: string): Promise<ChannelListingDefaults> {
    const instance = await this.prisma.channelInstance.findUnique({
      where: { id: channelInstanceId },
      select: { listingDefaults: true },
    });

    return parseListingDefaults(instance?.listingDefaults);
  }

  private async createOne(
    channelInstanceId: string,
    channel: Pick<ResolvedChannel, 'connector' | 'ctx'>,
    item: SelectedItem,
    content: {
      optionName: string;
      tags: readonly string[];
      metafields: readonly ListingMetafield[];
      category?: string;
      vendor?: string;
      price?: number;
    },
  ): Promise<CreatedListing> {
    const { catalogItem } = item.sku;
    const existing = item.allocations[0];
    const sku = skuCodeFor(item);

    // Already driving a listing for this item. Checked before the channel is
    // touched, because the cheapest way not to duplicate a product is not to
    // ask a platform to create one.
    if (existing?.externalListingId) {
      return {
        inventoryItemId: item.id,
        name: catalogItem.name,
        sku,
        externalListingId: existing.externalListingId,
        outcome: 'already-linked',
      };
    }

    // Sealed product, and anything whose condition is "not applicable", is one
    // product with one variant and no option at all — see
    // {@link UNVARIED_CONDITIONS}.
    //
    // It follows that such an item is never a *variant* of something either, so
    // no sibling is looked for. Two sealed SKUs of one catalogue product — an
    // English box and a Japanese one — become two products, which is what a
    // store carrying both wants; the alternative is a second variant on a
    // product that has no option to tell them apart.
    const unvaried = UNVARIED_CONDITIONS.includes(item.sku.condition);

    const siblingListingId = unvaried
      ? undefined
      : await this.findSibling(channelInstanceId, catalogItem.id, item.id);

    // The same split decides the title: a single names its set, sealed does not.
    const req: CreateListingRequest = { sku, title: titleFor(catalogItem, !unvaried) };

    if (!unvaried) {
      req.optionName = content.optionName;
      req.optionValue = optionValueFor(item.sku);
    }

    if (catalogItem.imageUrl) req.imageUrl = catalogItem.imageUrl;
    if (content.vendor) req.vendor = content.vendor;
    if (content.tags.length > 0) req.tags = content.tags;
    if (content.metafields.length > 0) req.metafields = content.metafields;
    if (content.category) req.category = content.category;
    if (siblingListingId) req.siblingListingId = siblingListingId;
    // A price the operator gave this run, or one the allocation already
    // carries. Creation still invents nothing — the same way it sets no
    // quantity — but sending a price we hold saves the storefront a spell as a
    // $0 draft, and saves a second push to correct it.
    const price = content.price ?? existing?.price ?? null;
    if (price != null) req.price = price;

    const { connector, ctx } = channel;
    const created = await this.limiter.run(connector.key, intervalFor(connector.rateLimit), () =>
      connector.createListing!(ctx, req),
    );

    const externalListingId = created.externalListingId?.trim();
    if (!externalListingId) {
      throw new Error(
        `${connector.displayName} reported no listing id, so nothing could be linked.`,
      );
    }

    // The same guard `applyLink` makes, for the same reason: one listing driven
    // by two inventory items means two of them pushing contradictory quantities
    // at one variant. Reachable here through `alreadyExisted` — the SKU may be
    // on a listing this hub already drives from another item, which is what a
    // hand-edited seller SKU produces.
    const claimed = await this.prisma.channelAllocation.findFirst({
      where: { channelInstanceId, externalListingId },
      select: { inventoryItemId: true },
    });
    if (claimed && claimed.inventoryItemId !== item.id) {
      throw new Error(
        `Listing ${externalListingId} already carries SKU "${sku}" and is driven by another ` +
          `inventory item. Nothing was changed on the channel; detach that allocation first.`,
      );
    }

    await this.inventory.upsertAllocation(item.id, {
      channelInstanceId,
      // Pooled unless the operator already made it fixed — the same default
      // linking uses. A fixed partition reserves stock exclusively, and nothing
      // about listing a card says they want that.
      mode: existing?.mode === 'fixed' ? 'fixed' : 'pooled',
      externalListingId,
      // Only when this run supplied one. Omitted leaves whatever the allocation
      // already had, so re-running a selection never silently reprices a card
      // the operator has since adjusted by hand.
      ...(content.price !== undefined ? { price: content.price } : {}),
    });

    return {
      inventoryItemId: item.id,
      name: catalogItem.name,
      sku,
      externalListingId,
      outcome: created.alreadyExisted
        ? 'already-existed'
        : created.createdProduct
          ? 'created-product'
          : 'added-variant',
    };
  }

  /**
   * A listing this channel already drives for another SKU of the same card.
   *
   * This is the whole of the core's grouping decision: one product per card, a
   * variant per condition. The connector is handed a *variant* id because that
   * is what `ChannelAllocation.externalListingId` holds — the core stores no
   * product ids and should not start, since a column would express something it
   * can already point at.
   */
  private async findSibling(
    channelInstanceId: string,
    catalogItemId: string,
    inventoryItemId: string,
  ): Promise<string | undefined> {
    const sibling = await this.prisma.channelAllocation.findFirst({
      where: {
        channelInstanceId,
        externalListingId: { not: null },
        inventoryItem: { sku: { catalogItemId } },
        NOT: { inventoryItemId },
      },
      // Oldest first, and by id where two share a timestamp: the grouping must
      // not depend on database row order, or two runs of the same selection
      // could attach variants to different products.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { externalListingId: true },
    });

    return sibling?.externalListingId ?? undefined;
  }

  private async loadItems(
    ids: readonly string[],
    channelInstanceId: string,
  ): Promise<Map<string, SelectedItem>> {
    const rows = await this.prisma.inventoryItem.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        sku: {
          select: {
            id: true,
            condition: true,
            printing: true,
            language: true,
            catalogItem: {
              select: {
                id: true,
                name: true,
                game: true,
                setName: true,
                imageUrl: true,
                externalRefs: { select: { source: true, externalId: true } },
              },
            },
          },
        },
        // Narrowed to this channel in the query, so `allocations[0]` is either
        // this channel's allocation or nothing. An item allocated to three
        // channels would otherwise hand back whichever row came first, and the
        // link would be written against a price and mode from another channel.
        allocations: {
          where: { channelInstanceId },
          select: { externalListingId: true, price: true, mode: true },
        },
      },
    });

    return new Map(rows.map((row) => [row.id, row]));
  }
}

/**
 * The code that goes in the channel's seller-SKU field.
 *
 * Under the same attribution `pickAttribution` gives a catalogue candidate, so
 * a later proposal run recognises it as `hub-sku` rather than falling back to a
 * name resemblance. Falls back to the hub's own namespace for a card no
 * catalogue knows — the case the operator specifically asked for, since "some
 * won't be listed on TCGPlayer".
 */
function skuCodeFor(item: SelectedItem): string {
  const attribution = pickAttribution(item.sku.catalogItem.externalRefs);

  return encodeSkuCode({
    sourceKey: attribution?.source ?? HUB_SOURCE_KEY,
    sourceId: attribution?.externalId ?? item.sku.id,
    condition: item.sku.condition,
    printing: item.sku.printing,
    language: item.sku.language,
  });
}

/**
 * What the product is called.
 *
 * **The set is appended for singles and not for sealed**, which is the
 * operator's rule and follows the same split as the variant option. The two
 * cases genuinely differ:
 *
 * - A sealed product's name already carries its set — "Phantasmal Flames
 *   Pokemon Center Elite Trainer Box (Exclusive)" — and the catalogue spells
 *   the set with a code the name lacks (`ME02: Phantasmal Flames`), so
 *   appending produced a title that said it twice.
 * - A single's name does not. "Charizard ex" exists in several sets, and
 *   creating each as "Charizard ex" leaves products that can only be told apart
 *   by opening them.
 *
 * The separator is safe against the matcher: `splitChannelTitle` splits on
 * " - " only when the tail parses as a *condition*, so "Charizard ex - SV04:
 * Paradox Rift" keeps its whole name while the variant's own " - Near Mint"
 * comes off as intended.
 */
export function titleFor(
  item: { name: string; setName: string | null },
  includeSet: boolean,
): string {
  const name = item.name.trim();
  if (!includeSet) return name;

  const setName = item.setName?.trim();
  if (!setName) return name;

  // A card literally named after its set — tcgcsv carries "Winterspell" in
  // Winterspell — must not become "Winterspell - Winterspell".
  if (name.toLowerCase().includes(setName.toLowerCase())) return name;

  return `${name} - ${setName}`;
}

/**
 * What this variant is called under the product's option.
 *
 * `formatCondition` where it can, which is TCGPlayer's own spelling of the same
 * four dimensions: "Near Mint", "Near Mint Holofoil", "Near Mint Holofoil -
 * Japanese". That is not cosmetic. Shopify titles a variant "<product> -
 * <option value>", and `deriveSkuDimensions` reads exactly that grammar back —
 * so a listing whose SKU field is later cleared by hand still says what
 * condition it is, in prose, in the one vocabulary this repository already
 * knows how to parse.
 *
 * The fallback is the raw tokens, for a SKU TCGPlayer has no spelling for
 * (`NA`, or a printing like `ETCHED` that Scryfall reports and they do not). It
 * reads worse and is still unique per SKU, which is the property that matters:
 * two variants of one product cannot share an option value.
 */
export function optionValueFor(sku: {
  condition: string;
  printing: string;
  language: string;
}): string {
  const formatted = formatCondition(sku);
  if (formatted.ok) return formatted.value;

  return [
    sku.condition,
    sku.printing === 'NORMAL' ? '' : sku.printing,
    sku.language === 'EN' ? '' : sku.language,
  ]
    .filter((part) => part !== '')
    .join(' ');
}
