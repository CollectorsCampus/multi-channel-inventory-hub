import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CatalogCtx, CatalogSource } from '@hub/connector-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogSourceRegistry } from '../catalog/catalog-source-registry.service';
import { CatalogCredentialsService } from '../catalog/catalog-credentials.service';
import { MinIntervalLimiter, intervalFor } from '../catalog/rate-limiter';
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

type ItemPrices = Map<string, Map<string, { source: string; cents: number }>>;

@Injectable()
export class RepriceService {
  private readonly logger = new Logger(RepriceService.name);
  private readonly limiter = new MinIntervalLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CatalogSourceRegistry,
    private readonly credentials: CatalogCredentialsService,
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

    const prices = await this.fetchPrices(catalogItems, report);
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
                sku: { include: { catalogItem: { select: { name: true, setName: true } } } },
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
  private async fetchPrices(
    catalogItems: Map<
      string,
      { game: string | null; setName: string | null; refs: Map<string, string> }
    >,
    report: SweepReport,
  ): Promise<ItemPrices> {
    const prices: ItemPrices = new Map();

    // ---- tcgcsv: whole set files for the sets the ledger holds -------------
    const tcgcsvItems = [...catalogItems.entries()].filter(
      ([, ci]) => ci.refs.has('tcgcsv') || ci.refs.has('tcgplayer'),
    );

    if (tcgcsvItems.length > 0 && this.registry.has('tcgcsv')) {
      const source = this.registry.get('tcgcsv');
      const ctx = await this.makeCtx(source);
      const interval = intervalFor(source.rateLimit);

      // Which set files to read, and for which games.
      const neededSets = new Map<string, { game: string; setName: string }>();
      for (const [id, ci] of tcgcsvItems) {
        if (!ci.game || !ci.setName) {
          report.problems.push(`Item ${id} has no game/set recorded; cannot price via tcgcsv.`);
          continue;
        }
        neededSets.set(`${ci.game} ${ci.setName}`, { game: ci.game, setName: ci.setName });
      }

      const setIds = new Map<string, string>();
      const games = [...new Set([...neededSets.values()].map((s) => s.game))];
      for (const game of games) {
        try {
          const sets = await this.limiter.run(source.key, interval, () =>
            source.listSets!(ctx, game),
          );
          for (const set of sets) setIds.set(`${game} ${set.name}`, set.setId);
        } catch (error) {
          report.problems.push(`tcgcsv sets for "${game}": ${(error as Error).message}`);
        }
      }

      // One id map for the whole source: candidate tcgcsv id -> per-printing cents.
      const byTcgcsvId = new Map<string, Record<string, number>>();
      for (const [key, { game, setName }] of neededSets) {
        const setId = setIds.get(key);
        if (!setId) {
          report.problems.push(`tcgcsv has no set named "${setName}" for "${game}".`);
          continue;
        }
        try {
          const candidates = await this.limiter.run(source.key, interval, () =>
            source.fetchSet!(ctx, setId),
          );
          for (const candidate of candidates) {
            const id = candidate.externalIds['tcgcsv'] ?? candidate.sourceId;
            const perPrinting =
              candidate.pricesByPrinting ??
              (candidate.marketPrice !== undefined ? { NORMAL: candidate.marketPrice } : undefined);
            if (perPrinting) byTcgcsvId.set(id, { ...perPrinting });
          }
        } catch (error) {
          report.problems.push(`tcgcsv set "${setName}": ${(error as Error).message}`);
        }
      }

      for (const [id, ci] of tcgcsvItems) {
        const refId = ci.refs.get('tcgcsv') ?? ci.refs.get('tcgplayer')!;
        const perPrinting = byTcgcsvId.get(refId);
        if (!perPrinting) continue;
        const forItem = prices.get(id) ?? new Map();
        for (const [printing, cents] of Object.entries(perPrinting)) {
          forItem.set(printing, { source: 'tcgcsv', cents });
        }
        prices.set(id, forItem);
      }
    }

    // ---- scryfall: per card, only where tcgcsv had nothing -----------------
    const scryfallItems = [...catalogItems.entries()].filter(
      ([id, ci]) => !prices.has(id) && ci.refs.has('scryfall'),
    );

    if (scryfallItems.length > 0 && this.registry.has('scryfall')) {
      const source = this.registry.get('scryfall');
      const ctx = await this.makeCtx(source);
      const interval = intervalFor(source.rateLimit);

      for (const [id, ci] of scryfallItems) {
        try {
          const candidate = await this.limiter.run(source.key, interval, () =>
            source.fetchById!(ctx, ci.refs.get('scryfall')!),
          );
          if (!candidate) continue;
          const perPrinting =
            candidate.pricesByPrinting ??
            (candidate.marketPrice !== undefined ? { NORMAL: candidate.marketPrice } : undefined);
          if (!perPrinting) continue;
          const forItem = new Map<string, { source: string; cents: number }>();
          for (const [printing, cents] of Object.entries(perPrinting)) {
            forItem.set(printing, { source: 'scryfall', cents });
          }
          prices.set(id, forItem);
        } catch (error) {
          report.problems.push(`scryfall ${ci.refs.get('scryfall')}: ${(error as Error).message}`);
        }
      }
    }

    return prices;
  }

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

  private async makeCtx(source: CatalogSource): Promise<CatalogCtx> {
    const context = `reprice:${source.key}`;
    return {
      secrets: await this.credentials.loadSecrets(source),
      logger: {
        debug: (m) => this.logger.debug(m, context),
        info: (m) => this.logger.log(m, context),
        warn: (m) => this.logger.warn(m, context),
        error: (m) => this.logger.error(m, context),
      },
    };
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
