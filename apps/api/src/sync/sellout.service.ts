import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hasCapability, type Connector, type Ctx } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelContextFactory } from '../connectors/channel-context.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
import { itemKind } from '../channels/listing-defaults';
import { AlertsService } from './alerts.service';

/**
 * Drafting a single's listing once its stock is gone.
 *
 * A card with none left is an unbuyable page: it takes a customer a click to
 * reach and tells them nothing except that we wasted it. Drafting removes it
 * from the storefront while leaving the product, its handle and its history
 * exactly where they are, so restocking is publishing rather than recreating.
 *
 * ## Two callers, one decision
 *
 * {@link draftIfSoldOut} is the whole policy, and both paths go through it:
 *
 * - **The event**: the outbound worker calls it the moment a quantity push
 *   takes an allocation to zero. Immediate, and the common case.
 * - **The sweep**: {@link sweepChannel} walks every linked single the ledger
 *   believes is at zero. It exists because the event can only fire where a
 *   push happened — it reaches nothing that sold out before the channel opted
 *   in, and nothing whose stock reached zero by a route that queued no push.
 *
 * They are one function rather than two implementations because the gates are
 * a judgement about the operator's storefront, and two copies of a judgement
 * eventually disagree — here that would show up as a product the nightly run
 * drafts and the live path does not, or the reverse, with nothing to say why.
 *
 * ## The gates, cheapest first
 *
 * The channel must have opted in (`draftAtSellout`); the connector must
 * declare `listing.status`; and the item must be a **single**. A sealed
 * listing was created and photographed by the operator and its visibility is
 * theirs — an Elite Trainer Box out of stock is a page a shop may well want to
 * keep. The connector then enforces the fourth gate against the platform's own
 * numbers (`onlyIfSoldOut`), so a product with an in-stock sibling variant, or
 * stock at a location the hub does not manage, is left alone.
 *
 * ## One direction, always
 *
 * A restock never re-publishes. Nothing should become buyable on a storefront
 * because a background job ran, and the asymmetry is deliberate rather than an
 * omission: drafting an in-stock card costs a sale until someone notices,
 * while publishing something the operator meant to keep back is a decision
 * they never made. They activate by hand, exactly as they do for a newly
 * created draft.
 */

/** What one listing's evaluation came to. */
export interface SelloutOutcome {
  drafted: boolean;
  /** Why not, when it was not — the platform's words where they exist. */
  reason?: string;
}

export interface SelloutRow {
  inventoryItemId: string;
  name: string;
  setName: string | null;
  condition: string;
  externalListingId: string;
  drafted: boolean;
  reason?: string;
}

export interface SelloutReport {
  /** Sold-out singles the sweep looked at. */
  checked: number;
  drafted: number;
  /** Looked at and left alone — usually the platform saying it still has stock. */
  skipped: number;
  rows: SelloutRow[];
  problems: Array<{ inventoryItemId?: string; message: string }>;
}

/** Distinguishes this service's `sync_failure` flag from the outbound worker's. */
const SELLOUT_FAILURE_SOURCE = 'sellout:sweep';

@Injectable()
export class SelloutService {
  private readonly logger = new Logger(SelloutService.name);
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelContextFactory,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * Draft one listing if every gate agrees. The single place the policy lives.
   *
   * Throws rather than swallowing: the sweep reports per row and the worker
   * catches, because a push that already landed must not be retried just
   * because the follow-up draft failed.
   */
  async draftIfSoldOut(
    connector: Connector,
    ctx: Ctx,
    channelInstanceId: string,
    listing: { externalListingId: string | null; inventoryItemId: string },
  ): Promise<SelloutOutcome> {
    if (!listing.externalListingId) return { drafted: false, reason: 'not linked' };
    if (!hasCapability(connector.capabilities, 'listing.status')) {
      return { drafted: false, reason: `${connector.displayName} cannot change listing status` };
    }

    const channel = await this.prisma.channelInstance.findUnique({
      where: { id: channelInstanceId },
      select: { draftAtSellout: true },
    });
    if (!channel?.draftAtSellout) return { drafted: false, reason: 'not enabled on this channel' };

    const item = await this.prisma.inventoryItem.findUnique({
      where: { id: listing.inventoryItemId },
      select: { sku: { select: { condition: true } } },
    });
    if (!item) return { drafted: false, reason: 'no such ledger item' };
    if (itemKind(item.sku.condition) !== 'single') {
      return { drafted: false, reason: 'not a single' };
    }

    const result = await connector.updateListingStatus!(ctx, {
      externalListingId: listing.externalListingId,
      status: 'draft',
      onlyIfSoldOut: true,
    });

    return result.changed
      ? { drafted: true }
      : { drafted: false, reason: result.reason ?? 'no change' };
  }

  /**
   * Every channel that has opted in, in turn.
   *
   * A channel that fails entirely is reported and the rest still run — one bad
   * token should not stop a second store's storefront being tidied.
   */
  async sweep(): Promise<SelloutReport> {
    const channels = await this.prisma.channelInstance.findMany({
      where: { enabled: true, draftAtSellout: true },
      select: { id: true, displayName: true },
    });

    const report: SelloutReport = {
      checked: 0,
      drafted: 0,
      skipped: 0,
      rows: [],
      problems: [],
    };

    for (const channel of channels) {
      try {
        const one = await this.sweepChannel(channel.id);
        report.checked += one.checked;
        report.drafted += one.drafted;
        report.skipped += one.skipped;
        report.rows.push(...one.rows);
        report.problems.push(...one.problems);
      } catch (error) {
        report.problems.push({
          message: `"${channel.displayName}": ${(error as Error).message}`,
        });
      }
    }

    this.logger.log(
      `Sellout sweep over ${channels.length} channel(s): ${report.checked} checked, ` +
        `${report.drafted} drafted, ${report.skipped} left alone, ` +
        `${report.problems.length} problem(s).`,
    );
    return report;
  }

  /**
   * One channel's sold-out singles.
   *
   * **Both zeros are required, and the redundancy is the safety.** A candidate
   * has `listedQuantity` 0 — what we believe the channel is advertising, so
   * the page really is unbuyable — *and* an item with nothing on hand at all.
   * The second is what makes an unattended run safe: with stock in the ledger
   * there could be a quantity push in flight, and drafting just ahead of one
   * leaves a card that is back in stock and invisible, which nothing here ever
   * undoes. An unbuyable page is a nuisance; a hidden in-stock card is lost
   * sales nobody sees.
   *
   * The event path is the one that acts on the exact derived figure, because
   * it has it in hand at the moment it changes. This is the catch-up, and it
   * is allowed to be blunter than the thing it is catching up with.
   *
   * Singles are filtered in memory rather than in the query so `itemKind`
   * stays the one place that decides what a single is.
   */
  async sweepChannel(channelInstanceId: string): Promise<SelloutReport> {
    const { connector, ctx, displayName } = await this.channels.resolve(channelInstanceId, {
      requireEnabled: true,
    });

    if (!hasCapability(connector.capabilities, 'listing.status')) {
      throw new BadRequestException(
        `${connector.displayName} cannot change a listing's status on "${displayName}".`,
      );
    }

    const channel = await this.prisma.channelInstance.findUniqueOrThrow({
      where: { id: channelInstanceId },
      select: { draftAtSellout: true },
    });
    // Refused rather than answered with an empty report: "off" and "nothing
    // sold out" are different facts, and only one of them is a setting.
    if (!channel.draftAtSellout) {
      throw new BadRequestException(
        `"${displayName}" does not draft sold-out singles. Turn it on in the channel's ` +
          'settings first.',
      );
    }

    const candidates = await this.prisma.channelAllocation.findMany({
      where: {
        channelInstanceId,
        externalListingId: { not: null },
        listedQuantity: 0,
        inventoryItem: { quantityOnHand: 0 },
      },
      select: {
        externalListingId: true,
        inventoryItemId: true,
        inventoryItem: {
          select: {
            sku: {
              select: {
                condition: true,
                catalogItem: { select: { name: true, setName: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const report: SelloutReport = { checked: 0, drafted: 0, skipped: 0, rows: [], problems: [] };

    for (const candidate of candidates) {
      const { sku } = candidate.inventoryItem;
      if (itemKind(sku.condition) !== 'single') continue;

      report.checked += 1;

      try {
        const outcome = await this.limiter.run(
          connector.key,
          intervalFor(connector.rateLimit),
          () => this.draftIfSoldOut(connector, ctx, channelInstanceId, candidate),
        );

        if (outcome.drafted) report.drafted += 1;
        else report.skipped += 1;

        report.rows.push({
          inventoryItemId: candidate.inventoryItemId,
          name: sku.catalogItem.name,
          setName: sku.catalogItem.setName,
          condition: sku.condition,
          externalListingId: candidate.externalListingId!,
          drafted: outcome.drafted,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
      } catch (error) {
        report.problems.push({
          inventoryItemId: candidate.inventoryItemId,
          message: `${sku.catalogItem.name}: ${(error as Error).message}`,
        });
      }
    }

    // A flag rather than an alert per failure, and cleared on a clean run: an
    // unattended nightly job that quietly stops working is exactly what the
    // inbox is for, but a store where forty listings fail is one problem.
    if (report.problems.length > 0) {
      await this.alerts.raiseFlag({
        kind: 'sync_failure',
        severity: 'warning',
        channelInstanceId,
        source: SELLOUT_FAILURE_SOURCE,
        title: `Could not draft sold-out listings on "${displayName}"`,
        detail: report.problems
          .slice(0, 5)
          .map((p) => p.message)
          .join('; '),
        context: { failed: report.problems.length },
      });
    } else {
      await this.alerts.clearFlag('sync_failure', channelInstanceId, SELLOUT_FAILURE_SOURCE);
    }

    this.logger.log(
      `Sellout run on "${displayName}": ${report.checked} sold-out single(s), ` +
        `${report.drafted} drafted, ${report.skipped} left alone, ` +
        `${report.problems.length} problem(s).`,
    );
    return report;
  }
}
