import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability } from '@hub/connector-sdk';
import type { ListingMetafield } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
import { parseListingDefaults, resolveMetafields, resolveTags } from '../channels/listing-defaults';
import { MAX_ITEMS } from './listing-creation.service';

/**
 * Back-filling the channel's listing rules onto listings that already exist.
 *
 * Creation applies the rules once, at birth. A rule written afterwards — or
 * edited, or added for a game the store only started carrying later — reaches
 * nothing that already exists, so a storefront accumulates listings the rules
 * would have described and didn't. On a tag-driven store that is not cosmetic:
 * every collection in the operator's shop is a tag equality rule, so an
 * untagged product is in no collection at all. Present in the admin, invisible
 * in the shop. A missing `custom.game` is quieter and no less real — it is what
 * the shop's own filtering and its card-attribute facets read.
 *
 * ## Additive for tags, fill-empty-only for custom fields
 *
 * The connector adds tags and never removes them, so one the seller applied by
 * hand survives and re-running is free. A custom field holds a single value, so
 * "add" has no meaning: one the listing already carries is left exactly as it
 * is, whatever it says. A rule that fires on the game cannot know the operator
 * hand-picked something else for one card, and last-writer-wins is how a
 * catalogue quietly relabels itself — the same argument that made the catalog
 * ingest's refresh fill-empty-only.
 *
 * ## Never automatic
 *
 * Nothing here is reachable from a push, a sweep or a queue. It writes to a
 * live storefront, so the operator selects the rows exactly as they do for an
 * image re-push, and a run larger than {@link MAX_ITEMS} is refused rather
 * than truncated: a partial batch of storefront writes is indistinguishable
 * from a complete one afterwards.
 *
 * ## Why the preview does not read the store
 *
 * {@link pending} answers from the ledger alone — what each listing's rules
 * resolve to — rather than asking the platform what each one currently carries.
 * A true diff would cost one API call per listing before the operator has
 * decided anything, which at the connector's 2/s is minutes of rate limit spent
 * on a screen that may be closed. The apply reports what it actually changed
 * per listing, so the *result* is the diff, and it is a measurement rather than
 * a prediction.
 */

export interface PendingListingAttributes {
  inventoryItemId: string;
  name: string;
  setName: string | null;
  game: string | null;
  condition: string;
  externalListingId: string;
  /** What this channel's rules say this listing should carry. */
  tags: string[];
  /**
   * The custom fields the rules resolve to, with the label the operator picked
   * them by where the channel's vocabulary still knows it. Named for display
   * only — the value is what is sent, verbatim.
   */
  metafields: Array<ListingMetafield & { label: string }>;
}

export interface BackfillAttributesResult {
  /** Listings something was actually written to, with what changed. */
  updated: Array<{
    inventoryItemId: string;
    name: string;
    added: string[];
    /**
     * The whole field, not its key: only the caller holds the store's
     * vocabulary, so naming `custom.game`'s value as "Pokémon" rather than as a
     * metaobject id can only happen there.
     */
    metafieldsSet: ListingMetafield[];
  }>;
  /** Listings that already carried everything: no write, no change. */
  unchanged: Array<{ inventoryItemId: string; name: string }>;
  problems: Array<{ inventoryItemId: string; name?: string; message: string }>;
}

@Injectable()
export class ListingAttributesService {
  private readonly logger = new Logger(ListingAttributesService.name);
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
  ) {}

  /**
   * Every linked listing on the channel, with what its rules resolve to.
   *
   * Listings whose rules produce nothing at all are omitted: there is no work
   * to offer, and a row saying "would change nothing" is noise on a screen
   * whose whole job is to be picked from.
   */
  async pending(channelInstanceId: string): Promise<PendingListingAttributes[]> {
    const { connector, displayName, channel } = await this.resolveChannel(channelInstanceId);

    const defaults = parseListingDefaults(channel.listingDefaults);

    const hasTagRules = (defaults.tagRules?.length ?? 0) > 0 || (defaults.tags?.length ?? 0) > 0;
    const hasFieldRules =
      (defaults.metafieldRules?.length ?? 0) > 0 || (defaults.metafields?.length ?? 0) > 0;

    // A channel with no rules has nothing to back-fill, and saying so is more
    // useful than an empty list the operator has to interpret.
    if (!hasTagRules && !hasFieldRules) {
      throw new BadRequestException(
        `"${displayName}" has no tag or custom-field rules yet, so there is nothing to apply. ` +
          'Add rules under New listings first.',
      );
    }

    if (!hasCapability(connector.capabilities, 'listing.attributes')) {
      throw new BadRequestException(
        `${connector.displayName} cannot change an existing listing's attributes on ` +
          `"${displayName}".`,
      );
    }

    const allocations = await this.prisma.channelAllocation.findMany({
      where: { channelInstanceId, externalListingId: { not: null } },
      select: {
        externalListingId: true,
        inventoryItem: {
          select: {
            id: true,
            sku: {
              select: {
                condition: true,
                catalogItem: { select: { name: true, setName: true, game: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return allocations.flatMap((allocation) => {
      const { inventoryItem } = allocation;
      const { sku } = inventoryItem;
      const { catalogItem } = sku;

      const item = {
        name: catalogItem.name,
        game: catalogItem.game,
        setName: catalogItem.setName,
        condition: sku.condition,
      };

      const tags = resolveTags(defaults, item);
      const metafields = resolveMetafields(defaults, item).map((field) => ({
        ...field,
        label: `${field.namespace}.${field.key}`,
      }));
      if (tags.length === 0 && metafields.length === 0) return [];

      return [
        {
          inventoryItemId: inventoryItem.id,
          name: catalogItem.name,
          setName: catalogItem.setName,
          game: catalogItem.game,
          condition: sku.condition,
          externalListingId: allocation.externalListingId!,
          tags,
          metafields,
        },
      ];
    });
  }

  /**
   * Apply each selected listing's resolved rules to what it already carries.
   *
   * Sequential and rate-limited like every other batch against a platform, and
   * each listing is independent: one failure is reported and the rest still
   * land.
   */
  async apply(
    channelInstanceId: string,
    inventoryItemIds: readonly string[],
    actorUserId?: string,
  ): Promise<BackfillAttributesResult> {
    const ids = [...new Set(inventoryItemIds)];

    if (ids.length === 0) {
      throw new BadRequestException('Select at least one listing to update.');
    }
    if (ids.length > MAX_ITEMS) {
      throw new BadRequestException(
        `${ids.length} items is more than one run may update. Select at most ${MAX_ITEMS}.`,
      );
    }

    const { connector, ctx, displayName, channel } = await this.resolveChannel(channelInstanceId, {
      requireEnabled: true,
    });

    // Carried so a conditional custom field can be satisfied on a product that
    // has no classification yet. The connector applies it only in that case —
    // reclassifying a product the operator already categorised is not this
    // feature's business.
    const { category } = parseListingDefaults(channel.listingDefaults);

    // Re-resolved rather than trusting what the screen was built from: the
    // rules may have been edited since it was opened, and the current rules
    // are the ones the operator means to apply.
    const eligible = new Map(
      (await this.pending(channelInstanceId)).map((row) => [row.inventoryItemId, row]),
    );

    const result: BackfillAttributesResult = { updated: [], unchanged: [], problems: [] };

    for (const id of ids) {
      const row = eligible.get(id);
      if (!row) {
        result.problems.push({
          inventoryItemId: id,
          message:
            'Not an updatable listing here: it must be linked, and its rules must produce ' +
            'a tag or a custom field.',
        });
        continue;
      }

      try {
        const outcome = await this.limiter.run(
          connector.key,
          intervalFor(connector.rateLimit),
          () =>
            connector.updateListingAttributes!(ctx, {
              externalListingId: row.externalListingId,
              addTags: row.tags,
              setMetafields: row.metafields.map(({ label: _label, ...field }) => field),
              ...(category ? { category } : {}),
            }),
        );

        const metafieldsSet = [...(outcome.metafieldsSet ?? [])];

        if (outcome.added.length > 0 || metafieldsSet.length > 0) {
          result.updated.push({
            inventoryItemId: id,
            name: row.name,
            added: [...outcome.added],
            metafieldsSet,
          });
        } else {
          result.unchanged.push({ inventoryItemId: id, name: row.name });
        }
      } catch (error) {
        result.problems.push({
          inventoryItemId: id,
          name: row.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `Listing-rule back-fill on "${displayName}" by ${actorUserId ?? 'unknown'}: ` +
        `${result.updated.length} updated, ${result.unchanged.length} already complete, ` +
        `${result.problems.length} problem(s).`,
    );

    return result;
  }

  private async resolveChannel(channelInstanceId: string, options?: { requireEnabled?: boolean }) {
    const resolved = await this.channels.resolve(channelInstanceId, options);
    const channel = await this.prisma.channelInstance.findUniqueOrThrow({
      where: { id: channelInstanceId },
      select: { listingDefaults: true },
    });
    return { ...resolved, channel };
  }
}
