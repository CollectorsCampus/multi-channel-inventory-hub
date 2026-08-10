import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
import { itemKind } from '../channels/listing-defaults';
import { MAX_ITEMS } from './listing-creation.service';

/**
 * Re-pushing catalogue images to listings this hub already drives.
 *
 * Exists because images improve after a listing is created: the catalogue
 * sources originally stored thumbnail-grade URLs, and the listings created
 * before the resolution upgrade carry those thumbnails on a live storefront.
 * Creation cannot fix them — it only ever runs once per listing — so this is
 * the deliberate second pass.
 *
 * ## Singles only, and why that is a data judgement rather than a limitation
 *
 * The operator's sealed listings were created by hand in Shopify, with imagery
 * they curated, and only *matched* to the ledger afterwards — replacing those
 * images would destroy work the hub never did. Singles are the opposite: the
 * store had none before this hub, so a single's imagery is exactly the
 * catalogue image creation supplied, and replacing it with the same image at
 * higher resolution destroys nothing. The line between the two is
 * {@link itemKind}, the same one place that already decides what a single is.
 *
 * ## Selected, never automatic
 *
 * The same constraint creation honours, for the same reason: replacement is
 * destructive of what it replaces, so the operator picks the rows (the screen
 * offers {@link pending} to pick from) and nothing here is reachable from a
 * push, a sweep or a queue.
 */

export interface PendingImagePush {
  inventoryItemId: string;
  name: string;
  setName: string | null;
  condition: string;
  externalListingId: string;
}

export interface PushImagesResult {
  updated: Array<{ inventoryItemId: string; name: string }>;
  problems: Array<{ inventoryItemId: string; name?: string; message: string }>;
}

@Injectable()
export class ListingImagesService {
  private readonly logger = new Logger(ListingImagesService.name);
  /** The connector's declared limit — each update is two or three calls. */
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
  ) {}

  /**
   * The listings a re-push could act on: linked singles whose catalogue item
   * carries an image.
   *
   * Offered so the screen shows what a run would touch and the operator picks
   * from it — the POST takes explicit ids, never "everything pending".
   */
  async pending(channelInstanceId: string): Promise<PendingImagePush[]> {
    const { connector, displayName } = await this.channels.resolve(channelInstanceId);

    if (!hasCapability(connector.capabilities, 'listing.image')) {
      throw new BadRequestException(
        `${connector.displayName} cannot update a listing's image on "${displayName}".`,
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
                catalogItem: { select: { name: true, setName: true, imageUrl: true } },
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

      // Filtered through the one place that decides what a single is, rather
      // than a condition list kept here that would eventually disagree with it.
      if (itemKind(sku.condition) !== 'single') return [];
      if (!sku.catalogItem.imageUrl) return [];

      return [
        {
          inventoryItemId: inventoryItem.id,
          name: sku.catalogItem.name,
          setName: sku.catalogItem.setName,
          condition: sku.condition,
          externalListingId: allocation.externalListingId!,
        },
      ];
    });
  }

  /**
   * Replace the images of the selected listings with the catalogue's current
   * ones.
   *
   * Sequential and rate-limited like every other batch against a platform.
   * Each item is independent: one failure is reported and the rest still land,
   * and re-running the same selection is harmless — the same image replaces
   * itself.
   */
  async push(
    channelInstanceId: string,
    inventoryItemIds: readonly string[],
    actorUserId?: string,
  ): Promise<PushImagesResult> {
    const ids = [...new Set(inventoryItemIds)];

    if (ids.length === 0) {
      throw new BadRequestException('Select at least one listing to update.');
    }
    if (ids.length > MAX_ITEMS) {
      // Refused, not truncated, as everywhere else: a partial batch of
      // storefront writes looks identical to a complete one afterwards.
      throw new BadRequestException(
        `${ids.length} items is more than one run may update. Select at most ${MAX_ITEMS}.`,
      );
    }

    const { connector, ctx, displayName } = await this.channels.resolve(channelInstanceId, {
      requireEnabled: true,
    });

    if (!hasCapability(connector.capabilities, 'listing.image')) {
      throw new BadRequestException(
        `${connector.displayName} cannot update a listing's image on "${displayName}".`,
      );
    }

    const eligible = new Map(
      (await this.pending(channelInstanceId)).map((row) => [row.inventoryItemId, row]),
    );

    const result: PushImagesResult = { updated: [], problems: [] };

    for (const id of ids) {
      const row = eligible.get(id);
      if (!row) {
        // One message for every ineligible shape — unlinked, sealed, imageless
        // or simply unknown — because the screen only offers eligible rows, so
        // reaching this means the state changed under the operator.
        result.problems.push({
          inventoryItemId: id,
          message:
            'Not an updatable listing here: it must be a linked single with a catalogue image.',
        });
        continue;
      }

      // Re-read the image URL at push time rather than trusting the pending
      // snapshot the screen was built from: the catalogue may have been
      // re-ingested since, and the whole point of this run is the current image.
      const item = await this.prisma.inventoryItem.findUnique({
        where: { id },
        select: { sku: { select: { catalogItem: { select: { imageUrl: true } } } } },
      });
      const imageUrl = item?.sku.catalogItem.imageUrl;
      if (!imageUrl) {
        result.problems.push({
          inventoryItemId: id,
          name: row.name,
          message: 'The catalogue item no longer has an image.',
        });
        continue;
      }

      try {
        await this.limiter.run(connector.key, intervalFor(connector.rateLimit), () =>
          connector.updateListingImage!(ctx, {
            externalListingId: row.externalListingId,
            imageUrl,
          }),
        );
        result.updated.push({ inventoryItemId: id, name: row.name });
      } catch (error) {
        result.problems.push({
          inventoryItemId: id,
          name: row.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `Updated ${result.updated.length} listing image(s) on "${displayName}" by ` +
        `${actorUserId ?? 'unknown'} (${result.problems.length} problem(s)).`,
    );

    return result;
  }
}
