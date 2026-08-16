import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
import { parseListingDefaults, resolveTags } from '../channels/listing-defaults';
import { MAX_ITEMS } from './listing-creation.service';

/**
 * Back-filling the channel's tag rules onto listings that already exist.
 *
 * Creation applies the rules once, at birth. A rule written afterwards — or
 * edited, or added for a game the store only started carrying later — reaches
 * nothing that already exists, so a storefront accumulates listings the rules
 * would have tagged and didn't. On a tag-driven store that is not cosmetic:
 * every collection in the operator's shop is a tag equality rule, so an
 * untagged product is in no collection at all. Present in the admin, invisible
 * in the shop.
 *
 * ## Additive, and never automatic
 *
 * The connector adds and never removes (`listing.attributes` is specified that
 * way), so a tag the seller applied by hand survives, and re-running is free —
 * a listing that already carries every tag is left untouched and reported as
 * unchanged rather than as work done.
 *
 * Nothing here is reachable from a push, a sweep or a queue. It writes to a
 * live storefront, so the operator selects the rows exactly as they do for an
 * image re-push, and a run larger than {@link MAX_ITEMS} is refused rather
 * than truncated: a partial batch of storefront writes is indistinguishable
 * from a complete one afterwards.
 *
 * ## Why the preview does not read the store
 *
 * {@link pending} answers from the ledger alone — the tags each listing's
 * rules resolve to — rather than asking the platform what each one currently
 * carries. A true diff would cost one API call per listing before the operator
 * has decided anything, which at the connector's 2/s is minutes of rate limit
 * spent on a screen that may be closed. The apply is additive and reports what
 * it actually added per listing, so the *result* is the diff, and it is a
 * measurement rather than a prediction.
 */

export interface PendingTagBackfill {
  inventoryItemId: string;
  name: string;
  setName: string | null;
  game: string | null;
  condition: string;
  externalListingId: string;
  /** What this channel's rules say this listing should carry. Never empty. */
  tags: string[];
}

export interface BackfillTagsResult {
  /** Listings whose tag set actually grew, with what was added. */
  updated: Array<{ inventoryItemId: string; name: string; added: string[] }>;
  /** Listings that already carried every tag: no write, no change. */
  unchanged: Array<{ inventoryItemId: string; name: string }>;
  problems: Array<{ inventoryItemId: string; name?: string; message: string }>;
}

@Injectable()
export class ListingTagsService {
  private readonly logger = new Logger(ListingTagsService.name);
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
  ) {}

  /**
   * Every linked listing on the channel, with the tags its rules resolve to.
   *
   * Listings whose rules produce nothing are omitted: there is no work to
   * offer, and a row saying "would add nothing" is noise on a screen whose
   * whole job is to be picked from.
   */
  async pending(channelInstanceId: string): Promise<PendingTagBackfill[]> {
    const { connector, displayName, channel } = await this.resolveChannel(channelInstanceId);

    const defaults = parseListingDefaults(channel.listingDefaults);

    // A channel with no tag rules has nothing to back-fill, and saying so is
    // more useful than an empty list the operator has to interpret.
    if ((defaults.tagRules?.length ?? 0) === 0 && (defaults.tags?.length ?? 0) === 0) {
      throw new BadRequestException(
        `"${displayName}" has no tag rules yet, so there is nothing to apply. ` +
          'Add rules under New listings first.',
      );
    }

    if (!hasCapability(connector.capabilities, 'listing.attributes')) {
      throw new BadRequestException(
        `${connector.displayName} cannot change an existing listing's tags on "${displayName}".`,
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

      const tags = resolveTags(defaults, {
        name: catalogItem.name,
        game: catalogItem.game,
        setName: catalogItem.setName,
        condition: sku.condition,
      });
      if (tags.length === 0) return [];

      return [
        {
          inventoryItemId: inventoryItem.id,
          name: catalogItem.name,
          setName: catalogItem.setName,
          game: catalogItem.game,
          condition: sku.condition,
          externalListingId: allocation.externalListingId!,
          tags,
        },
      ];
    });
  }

  /**
   * Add each selected listing's resolved tags to what it already carries.
   *
   * Sequential and rate-limited like every other batch against a platform, and
   * each listing is independent: one failure is reported and the rest still
   * land.
   */
  async apply(
    channelInstanceId: string,
    inventoryItemIds: readonly string[],
    actorUserId?: string,
  ): Promise<BackfillTagsResult> {
    const ids = [...new Set(inventoryItemIds)];

    if (ids.length === 0) {
      throw new BadRequestException('Select at least one listing to tag.');
    }
    if (ids.length > MAX_ITEMS) {
      throw new BadRequestException(
        `${ids.length} items is more than one run may update. Select at most ${MAX_ITEMS}.`,
      );
    }

    const { connector, ctx, displayName } = await this.channels.resolve(channelInstanceId, {
      requireEnabled: true,
    });

    // Re-resolved rather than trusting what the screen was built from: the
    // rules may have been edited since it was opened, and the current rules
    // are the ones the operator means to apply.
    const eligible = new Map(
      (await this.pending(channelInstanceId)).map((row) => [row.inventoryItemId, row]),
    );

    const result: BackfillTagsResult = { updated: [], unchanged: [], problems: [] };

    for (const id of ids) {
      const row = eligible.get(id);
      if (!row) {
        result.problems.push({
          inventoryItemId: id,
          message:
            'Not a taggable listing here: it must be linked, and its rules must produce a tag.',
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
            }),
        );

        if (outcome.added.length > 0) {
          result.updated.push({
            inventoryItemId: id,
            name: row.name,
            added: [...outcome.added],
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
      `Tag back-fill on "${displayName}" by ${actorUserId ?? 'unknown'}: ` +
        `${result.updated.length} updated, ${result.unchanged.length} already tagged, ` +
        `${result.problems.length} problem(s).`,
    );

    return result;
  }

  private async resolveChannel(channelInstanceId: string) {
    const resolved = await this.channels.resolve(channelInstanceId);
    const channel = await this.prisma.channelInstance.findUniqueOrThrow({
      where: { id: channelInstanceId },
      select: { listingDefaults: true },
    });
    return { ...resolved, channel };
  }
}
