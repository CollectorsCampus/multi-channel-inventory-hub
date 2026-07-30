import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability, type CatalogCandidate } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import { CatalogService } from '../catalog/catalog.service';
import { IntakeService } from '../inventory/intake.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  proposeMatches,
  type MatchProposal,
  type MatchTarget,
  type ProposalSummary,
} from './propose';

/**
 * Linking a channel's existing listings to the ledger.
 *
 * ## Why this is not optional polish
 *
 * `ChannelAllocation.externalListingId` had exactly one writer: the outbound
 * worker, from `pushListing`'s result. And Shopify's `pushListing` refuses to run
 * without one — "Create the product in Shopify, then set the variant id on this
 * allocation." Nothing in the API could set it. So for an operator with an
 * existing storefront the field could never be populated and every push failed
 * forever, which is a closed loop rather than a missing convenience.
 *
 * ## Set at a time, on purpose
 *
 * A proposal run is scoped to one set. That is not a limitation borrowed from
 * tcgcsv's lack of a search endpoint — it is the right size for the human at the
 * other end. Thirteen hundred proposals in one screen do not get reviewed; they
 * get accepted wholesale, which defeats the point of proposing. One set is a few
 * dozen rows, small enough that someone actually reads the `possible` ones.
 *
 * It also keeps the catalogue side cheap: a narrowed tcgcsv search downloads one
 * set file rather than walking a category.
 */

export interface ProposeRequest {
  channelInstanceId: string;
  /** Catalog source to draw candidates from — "tcgcsv", "scryfall". */
  sourceKey: string;
  /** Required: the set to scope this run to. */
  setName: string;
  game?: string;
  /** Channel pagination, opaque. */
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface ProposeResponse {
  proposals: MatchProposal[];
  summary: ProposalSummary;
  /** Listings skipped because they already have an allocation on this channel. */
  skipped: number;
  /** Channel cursor for the next page, absent on the last. */
  nextCursor?: string;
  /** How many catalogue candidates the set yielded, for when nothing matched. */
  candidateCount: number;
}

export interface ConfirmLink {
  /** The channel listing being linked. */
  externalListingId: string;
  /** Catalog source and its product id — the same pair intake takes. */
  sourceKey: string;
  sourceId: string;
  /**
   * SKU dimensions. Required, because the server will not guess a condition:
   * it decides most of what a single is worth.
   */
  condition: string;
  printing?: string;
  language?: string;
  /** Cents. Omitted leaves the allocation unpriced, which is a valid draft. */
  price?: number;
}

export interface ConfirmResult {
  linked: number;
  /** Links that were already exactly as requested. Re-confirming is a no-op. */
  unchanged: number;
  problems: Array<{ externalListingId: string; message: string }>;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
    private readonly sources: CatalogSourceRegistry,
    private readonly catalog: CatalogService,
    private readonly intake: IntakeService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Propose links for one page of a channel's listings, against one set.
   */
  async propose(request: ProposeRequest): Promise<ProposeResponse> {
    const setName = request.setName.trim();
    if (setName === '') {
      // Refused rather than defaulted to "everything": an unscoped run is both a
      // catalogue walk and a review screen nobody reads.
      throw new BadRequestException('A set name is required to propose matches.');
    }

    const { connector, ctx, displayName } = await this.channels.resolve(request.channelInstanceId, {
      signal: request.signal,
    });

    if (!hasCapability(connector.capabilities, 'listing.enumerate')) {
      throw new BadRequestException(
        `"${displayName}" cannot be matched: ${connector.displayName} cannot list what it is ` +
          `already selling. A file-based channel is matched through its import instead.`,
      );
    }

    const source = this.sources.get(request.sourceKey);

    // Both halves are fetched before anything is compared, so a failure on either
    // side surfaces as an error rather than as "nothing matched".
    const page = await connector.enumerateListings!(ctx, {
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });

    const candidates = await source.search(
      { logger: ctx.logger, secrets: {}, ...(request.signal ? { signal: request.signal } : {}) },
      {
        // The set is the scope; the text is deliberately broad because we want
        // the whole set as candidates, not a text search within it.
        text: setName,
        setName,
        ...(request.game !== undefined ? { game: request.game } : {}),
      },
    );

    const targets = candidates.map((candidate) => toTarget(candidate, request.sourceKey));
    const alreadyLinked = await this.linkedIds(request.channelInstanceId);

    const { proposals, summary, skipped } = proposeMatches(page.listings, targets, alreadyLinked);

    this.logger.log(
      `Proposed matches for "${displayName}" / ${setName}: ${summary.matched} matched ` +
        `(${summary.certain} certain), ${summary.ambiguous} ambiguous, ${summary.unmatched} ` +
        `unmatched, ${skipped} already linked, from ${targets.length} candidates.`,
    );

    return {
      proposals,
      summary,
      skipped,
      candidateCount: targets.length,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * Apply confirmed links.
   *
   * Each link is independent: one bad row reports a problem and the rest still
   * land. A reviewer who confirmed forty matches should not lose thirty-nine of
   * them because a product was deleted in Shopify while they were reading.
   */
  async confirm(
    channelInstanceId: string,
    links: readonly ConfirmLink[],
    actorUserId?: string,
  ): Promise<ConfirmResult> {
    const { displayName } = await this.channels.resolve(channelInstanceId);

    const result: ConfirmResult = { linked: 0, unchanged: 0, problems: [] };

    // Sequential rather than parallel. Two links can land on the same inventory
    // item, and `upsertAllocation` takes the optimistic-locking path — running
    // them concurrently would spend the retry budget contending with itself.
    for (const link of links) {
      try {
        const outcome = await this.applyLink(channelInstanceId, link);
        if (outcome === 'unchanged') result.unchanged++;
        else result.linked++;
      } catch (error) {
        result.problems.push({
          externalListingId: link.externalListingId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `Confirmed ${result.linked} link(s) on "${displayName}" by ${actorUserId ?? 'unknown'} ` +
        `(${result.unchanged} unchanged, ${result.problems.length} problem(s)).`,
    );

    return result;
  }

  // -------------------------------------------------------------------------

  private async applyLink(
    channelInstanceId: string,
    link: ConfirmLink,
  ): Promise<'linked' | 'unchanged'> {
    const externalListingId = link.externalListingId.trim();
    if (externalListingId === '') {
      throw new BadRequestException('A link needs the channel listing id.');
    }

    // Already pointing at this listing from another item: refuse rather than
    // silently create a second allocation for one listing, which would have two
    // inventory items pushing contradictory quantities to the same variant.
    const conflicting = await this.prisma.channelAllocation.findFirst({
      where: { channelInstanceId, externalListingId },
      select: { id: true, inventoryItemId: true },
    });

    // Re-fetched from the source, never taken from the request. `IntakeDto` spells
    // out why: trusting a client-supplied name or external id would let it write
    // arbitrary values into `CatalogExternalRef`, which is what every future
    // listing is keyed on.
    const candidate = await this.catalog.fetchCandidate(link.sourceKey, link.sourceId);
    if (!candidate) {
      throw new BadRequestException(
        this.catalog.canRefetch(link.sourceKey)
          ? `Catalog source "${link.sourceKey}" has no product "${link.sourceId}".`
          : `Catalog source "${link.sourceKey}" cannot re-verify a product by id, so a link ` +
              `to it cannot be confirmed. Propose against the set first.`,
      );
    }

    // Identity only: no stock is received, so this must not go through `intake`,
    // which requires a positive quantity. IntakeService still owns the writes so
    // catalog-item resolution and InventoryItem creation keep one owner.
    const ensured = await this.intake.ensureSku(candidate, {
      condition: link.condition,
      ...(link.printing !== undefined ? { printing: link.printing } : {}),
      ...(link.language !== undefined ? { language: link.language } : {}),
    });

    const inventoryItemId = ensured.inventoryItemId;

    if (conflicting && conflicting.inventoryItemId !== inventoryItemId) {
      throw new BadRequestException(
        `Listing ${externalListingId} is already linked to a different inventory item. ` +
          `Detach that allocation first.`,
      );
    }

    const existing = await this.prisma.channelAllocation.findUnique({
      where: { inventoryItemId_channelInstanceId: { inventoryItemId, channelInstanceId } },
      select: { externalListingId: true, price: true, mode: true },
    });

    // Idempotent: re-confirming the same link changes nothing rather than
    // rewriting the row and bumping the version for no reason.
    if (
      existing?.externalListingId === externalListingId &&
      (link.price === undefined || existing.price === link.price)
    ) {
      return 'unchanged';
    }

    await this.inventory.upsertAllocation(inventoryItemId, {
      channelInstanceId,
      // Pooled with no cap: the safe default. A fixed partition reserves stock
      // exclusively, and nothing about linking a listing says the operator wants
      // that. They can change it afterwards.
      mode: existing?.mode === 'fixed' ? 'fixed' : 'pooled',
      externalListingId,
      ...(link.price !== undefined ? { price: link.price } : {}),
    });

    return 'linked';
  }

  /** Every listing id this channel already drives, so matching skips them. */
  private async linkedIds(channelInstanceId: string): Promise<Set<string>> {
    const rows = await this.prisma.channelAllocation.findMany({
      where: { channelInstanceId, externalListingId: { not: null } },
      select: { externalListingId: true },
    });

    return new Set(rows.map((r) => r.externalListingId).filter((id): id is string => id !== null));
  }
}

/**
 * A catalogue candidate as a match target.
 *
 * The candidate's own source key is included in `externalIds` alongside whatever
 * platform ids it carries, so a seller whose Shopify SKU field holds a Scryfall
 * id matches just as well as one holding a TCGPlayer id.
 */
function toTarget(candidate: CatalogCandidate, sourceKey: string): MatchTarget {
  const target: MatchTarget = {
    id: candidate.sourceId,
    name: candidate.name,
    externalIds: { ...candidate.externalIds, [sourceKey]: candidate.sourceId },
  };

  if (candidate.setName !== undefined) target.setName = candidate.setName;
  if (candidate.game !== undefined) target.game = candidate.game;

  return target;
}
