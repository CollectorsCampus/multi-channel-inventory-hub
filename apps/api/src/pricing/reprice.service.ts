import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import { MarketPriceService, type ItemPrices } from './market-prices.service';
import { OutboundQueue } from '../queue/outbound-queue.service';
import { AlertsService } from '../sync/alerts.service';
import {
  classifyChange,
  describeBasis,
  isRepricingActive,
  parseRepricingPolicy,
  targetPrice,
  type RepricingPolicy,
} from './repricing';

/** Distinguishes the sweep's review flag from any other source's. */
const REVIEW_FLAG_SOURCE = 'pricing:sweep';

/**
 * The repricing sweep: pull current market prices for everything the ledger
 * has allocated, then move asking prices toward them under each channel's
 * policy — automatically within the operator's threshold, by proposal above
 * it.
 *
 * ## Where prices come from, and why the fetch looks like ingest
 *
 * Only tcgcsv and Scryfall publish prices (CardTrader's catalogue carries
 * none). tcgcsv cannot fetch one product cold — its `fetchById` only resolves
 * from set files already read — so the sweep fetches **whole set files** for
 * the sets the ledger actually holds, exactly the access pattern the source
 * was built for. Set files are found by exact `setName` match against
 * `listSets`, which is reliable for tcgcsv-ingested items because their stored
 * names came from that same listing. Scryfall resolves per card by id.
 *
 * ## The judgement lives in `repricing.ts`
 *
 * This service does I/O around pure functions, the way `reconcile.service`
 * does: what a SKU should cost, and whether a change is auto or review, is
 * decided by `targetPrice`/`classifyChange` and tested without a database.
 *
 * ## What an applied change touches
 *
 * A price write is `channelAllocation.price` plus an outbound `price` push —
 * never a quantity, so rule 5 is not in play. The push goes through the same
 * worker as every other outbound write and lands in the sync log.
 */

export interface SweepReport {
  /** Catalog items whose market price was looked for. */
  itemsConsidered: number;
  /** (item, printing) price figures recorded. */
  pricesRecorded: number;
  autoApplied: number;
  proposed: number;
  problems: string[];
}

export interface ProposalRow {
  id: string;
  allocationId: string;
  channelInstanceId: string;
  channelName: string;
  name: string;
  setName: string | null;
  /**
   * The catalogue's external ids, keyed by source — what a reviewer needs to
   * open the page the market figure came from.
   *
   * Ids, never URLs: which sources have a linkable public page is a fact about
   * the web that has already changed once (Cardmarket's product pages went
   * behind bot protection), and the web app owns that judgement in
   * `externalLinks`. A URL built here would put it in two places.
   */
  externalIds: Record<string, string>;
  condition: string;
  printing: string;
  currentPrice: number | null;
  proposedPrice: number;
  marketPrice: number;
  source: string;
  basis: string;
  createdAt: Date;
}

/** Sources that publish prices, in preference order. tcgplayer shares tcgcsv's id space. */
const PRICED_SOURCES = ['tcgcsv', 'scryfall'] as const;

@Injectable()
export class RepriceService {
  private readonly logger = new Logger(RepriceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketPrices: MarketPriceService,
    private readonly outbound: OutboundQueue,
    private readonly alerts: AlertsService,
  ) {}

  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      itemsConsidered: 0,
      pricesRecorded: 0,
      autoApplied: 0,
      proposed: 0,
      problems: [],
    };

    const items = await this.loadAllocatedItems();
    const catalogItems = new Map<
      string,
      { game: string | null; setName: string | null; refs: Map<string, string> }
    >();
    for (const item of items) {
      const ci = item.sku.catalogItem;
      if (!catalogItems.has(ci.id)) {
        catalogItems.set(ci.id, {
          game: ci.game,
          setName: ci.setName,
          refs: new Map(ci.externalRefs.map((r) => [r.source, r.externalId])),
        });
      }
    }
    report.itemsConsidered = catalogItems.size;

    // Delegated: `BulkAllocateService` needs the same answer, and two copies of
    // "which source prices this card" would diverge the first time either
    // changed — the sweep then arguing with the price an allocation was created
    // at, a night after it was created.
    const { prices, problems } = await this.marketPrices.fetchPrices(catalogItems);
    report.problems.push(...problems);
    report.pricesRecorded = await this.recordPrices(prices);

    await this.reprice(items, prices, report);

    this.logger.log(
      `Reprice sweep: ${report.itemsConsidered} item(s), ${report.pricesRecorded} price(s), ` +
        `${report.autoApplied} auto-applied, ${report.proposed} proposed, ` +
        `${report.problems.length} problem(s).`,
    );
    return report;
  }

  /** Pending proposals, named for a human. */
  async listProposals(): Promise<ProposalRow[]> {
    const rows = await this.prisma.repriceProposal.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        allocation: {
          include: {
            channelInstance: { select: { displayName: true } },
            inventoryItem: {
              include: {
                sku: {
                  include: {
                    catalogItem: {
                      select: {
                        name: true,
                        setName: true,
                        // The ids behind the market figure. Reviewing a price
                        // means checking it against the page it came from, and
                        // the id is the only thing that can address that page —
                        // the caller turns it into a URL, since which sources
                        // have a linkable public page is a fact about the web
                        // rather than about the ledger.
                        externalRefs: { select: { source: true, externalId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      allocationId: row.allocationId,
      channelInstanceId: row.allocation.channelInstanceId,
      channelName: row.allocation.channelInstance.displayName,
      name: row.allocation.inventoryItem.sku.catalogItem.name,
      setName: row.allocation.inventoryItem.sku.catalogItem.setName,
      externalIds: Object.fromEntries(
        row.allocation.inventoryItem.sku.catalogItem.externalRefs.map((ref) => [
          ref.source,
          ref.externalId,
        ]),
      ),
      condition: row.allocation.inventoryItem.sku.condition,
      printing: row.allocation.inventoryItem.sku.printing,
      currentPrice: row.currentPrice,
      proposedPrice: row.proposedPrice,
      marketPrice: row.marketPrice,
      source: row.source,
      basis: row.basis,
      createdAt: row.createdAt,
    }));
  }

  /** Apply one reviewed proposal: write the price, queue the push, drop the row. */
  async applyProposal(id: string): Promise<void> {
    const proposal = await this.prisma.repriceProposal.findUnique({
      where: { id },
      include: { allocation: { include: { channelInstance: { select: { connectorKey: true } } } } },
    });
    if (!proposal) throw new NotFoundException('No such proposal; it may have been decided.');

    await this.applyPrice(
      proposal.allocationId,
      proposal.allocation.channelInstanceId,
      proposal.allocation.channelInstance.connectorKey,
      proposal.proposedPrice,
    );
    await this.prisma.repriceProposal.deleteMany({ where: { id } });
  }

  /**
   * Dismiss one proposal. Deliberately not remembered: the next sweep will
   * re-propose the same change if the market still says so — the market still
   * says what it says.
   */
  async dismissProposal(id: string): Promise<void> {
    const deleted = await this.prisma.repriceProposal.deleteMany({ where: { id } });
    if (deleted.count === 0) {
      throw new NotFoundException('No such proposal; it may have been decided.');
    }
  }

  // -------------------------------------------------------------------------

  private async loadAllocatedItems() {
    return this.prisma.inventoryItem.findMany({
      where: { allocations: { some: {} } },
      select: {
        id: true,
        quantityOnHand: true,
        sku: {
          select: {
            condition: true,
            printing: true,
            catalogItem: {
              select: {
                id: true,
                game: true,
                setName: true,
                externalRefs: { select: { source: true, externalId: true } },
              },
            },
          },
        },
        allocations: {
          select: {
            id: true,
            channelInstanceId: true,
            price: true,
            externalListingId: true,
          },
        },
      },
    });
  }

  /**
   * Current market figures per catalog item and printing, from the first
   * priced source each item carries a ref for.
   */
  /** Persist the latest figures, keeping the previous for was/now display. */
  private async recordPrices(prices: ItemPrices): Promise<number> {
    const fetchedAt = new Date();
    let recorded = 0;

    for (const [catalogItemId, perPrinting] of prices) {
      for (const [printing, { source, cents }] of perPrinting) {
        const existing = await this.prisma.marketPrice.findUnique({
          where: { catalogItemId_source_printing: { catalogItemId, source, printing } },
          select: { price: true },
        });
        await this.prisma.marketPrice.upsert({
          where: { catalogItemId_source_printing: { catalogItemId, source, printing } },
          create: { catalogItemId, source, printing, price: cents, fetchedAt },
          update: {
            price: cents,
            fetchedAt,
            ...(existing && existing.price !== cents ? { previousPrice: existing.price } : {}),
          },
        });
        recorded += 1;
      }
    }
    return recorded;
  }

  private async reprice(
    items: Awaited<ReturnType<RepriceService['loadAllocatedItems']>>,
    prices: ItemPrices,
    report: SweepReport,
  ): Promise<void> {
    const channels = await this.prisma.channelInstance.findMany({
      where: { enabled: true },
      select: { id: true, connectorKey: true, repricingPolicy: true },
    });
    const policies = new Map<string, { policy: RepricingPolicy; connectorKey: string }>();
    for (const channel of channels) {
      const policy = parseRepricingPolicy(channel.repricingPolicy);
      if (isRepricingActive(policy)) {
        policies.set(channel.id, { policy, connectorKey: channel.connectorKey });
      }
    }
    if (policies.size === 0) return;

    const proposedByChannel = new Map<string, number>();

    for (const item of items) {
      const perPrinting = prices.get(item.sku.catalogItem.id);
      const market = perPrinting?.get(item.sku.printing);

      for (const allocation of item.allocations) {
        const channel = policies.get(allocation.channelInstanceId);
        if (!channel) continue;

        // Greater than zero, not merely non-zero: Shopify reports negative
        // available for oversold stock, and an oversold item is the last one
        // whose price should churn. Prices were still *recorded* above — the
        // toggle gates repricing, not the market data.
        if (channel.policy.inStockOnly && item.quantityOnHand <= 0) {
          await this.prisma.repriceProposal.deleteMany({ where: { allocationId: allocation.id } });
          continue;
        }

        // No market figure for this exact printing means nothing to say —
        // never a fallback to another printing's number.
        const target = market
          ? targetPrice(channel.policy, item.sku.condition, market.cents)
          : undefined;
        if (target === undefined) {
          await this.prisma.repriceProposal.deleteMany({ where: { allocationId: allocation.id } });
          continue;
        }

        const { action } = classifyChange(channel.policy, allocation.price, target);

        if (action === 'skip') {
          await this.prisma.repriceProposal.deleteMany({ where: { allocationId: allocation.id } });
          continue;
        }

        if (action === 'auto') {
          try {
            await this.applyPrice(
              allocation.id,
              allocation.channelInstanceId,
              channel.connectorKey,
              target,
            );
            await this.prisma.repriceProposal.deleteMany({
              where: { allocationId: allocation.id },
            });
            report.autoApplied += 1;
          } catch (error) {
            report.problems.push(
              `Auto-apply for allocation ${allocation.id}: ${(error as Error).message}`,
            );
          }
          continue;
        }

        const basis = describeBasis(channel.policy, item.sku.condition, market!.cents);
        await this.prisma.repriceProposal.upsert({
          where: { allocationId: allocation.id },
          create: {
            allocationId: allocation.id,
            currentPrice: allocation.price,
            proposedPrice: target,
            marketPrice: market!.cents,
            source: market!.source,
            basis,
          },
          update: {
            currentPrice: allocation.price,
            proposedPrice: target,
            marketPrice: market!.cents,
            source: market!.source,
            basis,
            createdAt: new Date(),
          },
        });
        report.proposed += 1;
        proposedByChannel.set(
          allocation.channelInstanceId,
          (proposedByChannel.get(allocation.channelInstanceId) ?? 0) + 1,
        );
      }
    }

    // One flag per channel, refreshed while proposals wait, cleared when none.
    for (const channelId of policies.keys()) {
      const pending = await this.prisma.repriceProposal.count({
        where: { allocation: { channelInstanceId: channelId } },
      });
      if (pending > 0) {
        await this.alerts.raiseFlag({
          kind: 'reprice_review',
          source: REVIEW_FLAG_SOURCE,
          severity: 'info',
          channelInstanceId: channelId,
          title: `${pending} price change(s) awaiting review`,
          detail: () =>
            `The market moved further than the auto-apply threshold on ${pending} listing(s). ` +
            `Review them on the channel's repricing panel.`,
        });
      } else {
        await this.alerts.clearFlag('reprice_review', channelId, REVIEW_FLAG_SOURCE);
      }
    }
  }

  /**
   * Write the price and queue the push.
   *
   * A direct column write, deliberately not `upsertAllocation`: the price is
   * channel data, not a quantity, and going through the allocation engine
   * would mean restating mode and partition figures this service has no
   * business touching (rule 5 guards quantities; this touches none).
   */
  private async applyPrice(
    allocationId: string,
    channelInstanceId: string,
    connectorKey: string,
    priceCents: number,
  ): Promise<void> {
    await this.prisma.channelAllocation.update({
      where: { id: allocationId },
      data: { price: priceCents },
    });
    await this.outbound.enqueue(connectorKey, {
      channelInstanceId,
      allocationId,
      operation: 'price',
    });
  }
}

/** Guard used by the controller: sweeping needs at least one priced source registered. */
export function assertPricedSourcesAvailable(registry: CatalogSourceRegistry): void {
  if (!PRICED_SOURCES.some((key) => registry.has(key))) {
    throw new BadRequestException(
      'No price-publishing catalog source is registered, so there is nothing to sweep.',
    );
  }
}
