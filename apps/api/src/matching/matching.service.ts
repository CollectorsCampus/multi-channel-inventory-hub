import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability, type CatalogCandidate } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import { CatalogService } from '../catalog/catalog.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
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

/**
 * How many local candidates one proposal run may draw.
 *
 * A real set runs to a few hundred products — Prismatic Evolutions has 499 — and
 * the whole set is what a match needs. Well above that so a large set is not
 * silently clipped, which would show up as listings mysteriously unmatched.
 */
const LOCAL_CANDIDATE_LIMIT = 2000;

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

export interface ConfirmOptions {
  /**
   * Also stamp the catalogue's platform id into the channel's seller-SKU field.
   *
   * **Off unless asked, because it overwrites.** On a real storefront that field
   * usually holds a code the seller relies on — a supplier reference, a POS key —
   * and the hub has no way to know which. The operator who turns this on is
   * saying they would rather have the mapping recorded on the platform, where a
   * rebuilt hub can re-derive every link instead of asking them to match 1,300
   * items again.
   *
   * Only ever applied to a listing whose link was just confirmed. Nothing is
   * written for an unmatched or ambiguous row.
   */
  writeSkuToChannel?: boolean;
  actorUserId?: string;
}

export interface ConfirmResult {
  linked: number;
  /** Links that were already exactly as requested. Re-confirming is a no-op. */
  unchanged: number;
  /** Channel listings whose SKU field was rewritten. */
  skuWritten: number;
  problems: Array<{ externalListingId: string; message: string }>;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  /**
   * Channel writes are rate limited by the connector's own declared limit, the
   * same way reconciliation does it. Shopify allows 2/s, and a batch of forty
   * confirmations would otherwise burst straight through it.
   */
  private readonly limiter = new MinIntervalLimiter();

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
      // The set narrows the channel side too, where the platform can. Without it
      // a page of a real storefront spans every set while the candidates are one
      // set — measured at 2 matches and 98 rows of noise on a live Pokémon shop,
      // and the noise is what stops a review screen being read.
      search: setName,
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });

    // The local catalog first, when the set has been ingested.
    //
    // Worth more here than anywhere else: a proposal run needs the *whole* set
    // as candidates, which is exactly the request tcgcsv is least willing to
    // serve — it caps set files per search and refuses anything un-narrowed. An
    // ingested set answers instantly, offline, and without spending a
    // rate-limited request on data already stored.
    //
    // Falls back to the live source when the set is not ingested, so nothing
    // that worked before this needs an ingest to keep working.
    const local = await this.catalog.searchLocal({
      // Empty text: the set is the filter. A text search *within* the set would
      // return a fraction of it, and a fraction is not a candidate list.
      text: '',
      setName,
      ...(request.game !== undefined ? { game: request.game } : {}),
      limit: LOCAL_CANDIDATE_LIMIT,
    });

    const candidates =
      local.length > 0
        ? local
        : await source.search(
            {
              logger: ctx.logger,
              secrets: {},
              ...(request.signal ? { signal: request.signal } : {}),
            },
            {
              // The set is the scope; the text is deliberately broad because we
              // want the whole set as candidates, not a text search within it.
              text: setName,
              setName,
              ...(request.game !== undefined ? { game: request.game } : {}),
            },
          );

    // `source.key`, not `request.sourceKey`. The registry's own key is canonical
    // and, unlike the request string, is not a user-controlled value being used
    // as a property name — CodeQL flagged that as remote property injection and
    // was right to. `validateCatalogSource` constrains the real key to
    // `[a-z0-9-]`, so this is also the only spelling that can match anything.
    const targets = candidates.map((candidate) => toTarget(candidate, source.key));
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
    options: ConfirmOptions = {},
  ): Promise<ConfirmResult> {
    const { connector, ctx, displayName } = await this.channels.resolve(channelInstanceId);

    const canWriteSku =
      options.writeSkuToChannel === true && hasCapability(connector.capabilities, 'listing.sku');

    if (options.writeSkuToChannel === true && !canWriteSku) {
      throw new BadRequestException(
        `${connector.displayName} cannot write a SKU back to a listing, so ids cannot be ` +
          `recorded on "${displayName}".`,
      );
    }

    const result: ConfirmResult = { linked: 0, unchanged: 0, skuWritten: 0, problems: [] };

    // Sequential rather than parallel. Two links can land on the same inventory
    // item, and `upsertAllocation` takes the optimistic-locking path — running
    // them concurrently would spend the retry budget contending with itself.
    for (const link of links) {
      try {
        const outcome = await this.applyLink(channelInstanceId, link);
        if (outcome === 'unchanged') result.unchanged++;
        else result.linked++;

        // Only after the link is safely recorded here. Writing to the channel
        // first and then failing locally would leave the storefront stamped with
        // an id this hub has no allocation for — a lie that survives a restart.
        if (canWriteSku) {
          await this.limiter.run(connector.key, intervalFor(connector.rateLimit), () =>
            connector.updateListingSku!(ctx, {
              externalListingId: link.externalListingId,
              sku: link.sourceId,
            }),
          );
          result.skuWritten++;
        }
      } catch (error) {
        result.problems.push({
          externalListingId: link.externalListingId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `Confirmed ${result.linked} link(s) on "${displayName}" by ` +
        `${options.actorUserId ?? 'unknown'} (${result.unchanged} unchanged, ` +
        `${result.skuWritten} SKU(s) rewritten, ${result.problems.length} problem(s)).`,
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

    // The mirror of the guard above, and the one that was missing.
    //
    // One inventory item holds at most one allocation per channel — that is
    // `@@unique([inventoryItemId, channelInstanceId])`. So when a *second*
    // listing resolves to an item this channel already drives, writing it does
    // not add a link, it moves the existing one: the first listing is silently
    // detached, and `confirm` still reports it as linked. The operator is told
    // two listings are managed while one has quietly stopped being.
    //
    // It is not a rare shape. A storefront legitimately sells one catalogue
    // product under two listings — a Pokemon Center exclusive beside the regular
    // printing, a case beside a pack — and the catalogue may carry only one of
    // them. Refused rather than resolved, for the same reason `propose` reports
    // a tie instead of picking: which listing should own the stock is the
    // operator's call, and guessing it loses the other one.
    if (existing?.externalListingId != null && existing.externalListingId !== externalListingId) {
      throw new BadRequestException(
        `"${candidate.name}" is already linked to listing ${existing.externalListingId} on this ` +
          `channel, so ${externalListingId} cannot also claim it — one item can drive one ` +
          `listing per channel. Detach that allocation first, or link this listing to a ` +
          `catalog product of its own.`,
      );
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
