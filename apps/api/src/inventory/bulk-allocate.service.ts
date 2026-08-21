import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { parseRepricingPolicy, targetPrice } from '../pricing/repricing';
import { MAX_ITEMS } from '../listings/listing-creation.service';

/**
 * Putting a batch of ledger items onto a channel in one action, priced from the
 * market.
 *
 * The operator's own framing: select several rows and add them all, without
 * typing a price for each. Everything about the pricing follows from taking
 * that seriously.
 *
 * ## Why the price is the channel's target, not the raw market figure
 *
 * "Use the market price" is the obvious reading, and it is wrong in a way that
 * shows up the same night. `market_prices` holds what a card is *worth*; a
 * channel's `conditionPercents` is what the operator sells it *for*. Writing
 * the market figure onto an allocation whose policy says LP sells at 80% means
 * the next repricing sweep immediately proposes changing every price this just
 * set — a review queue full of items created minutes earlier, all of them
 * disagreeing with the policy that created them.
 *
 * So this asks {@link targetPrice} for exactly what repricing would ask for.
 * Where the policy is 100% for a condition the two answers are identical, which
 * is the common case and why the distinction is easy to miss.
 *
 * ## What it refuses rather than guesses
 *
 * A condition the policy declares no percentage for is **skipped and
 * reported**, never priced at the raw market figure. That would be the software
 * deciding a Lightly Played copy is worth the same as a Near Mint one, which is
 * the single thing `conditionPercents` exists to refuse — the same reason
 * `deriveSkuDimensions` will not default a condition, and the reason repricing
 * itself never touches an undeclared condition.
 *
 * An item the sweep has never priced is skipped for the same kind of reason:
 * `MarketPrice` is latest-only and populated by the sweep, which visits
 * allocated items, so an unlisted card legitimately has no figure. There is
 * nothing to price it from and inventing one is not an option.
 *
 * ## Preview first
 *
 * {@link preview} answers with the price each item would get and the reason
 * each skipped one is skipped, so the operator sees the outcome before anything
 * is written. That matters more here than for a tag back-fill: this creates
 * allocations, and an allocation with a price is a number a customer will see
 * as soon as the push lands.
 */

export interface BulkAllocationRow {
  inventoryItemId: string;
  name: string;
  setName: string | null;
  condition: string;
  printing: string;
  /** What the allocation would be priced at, in cents. Null when skipped. */
  price: number | null;
  /** The market figure it was derived from, for the operator to sanity-check. */
  marketPrice: number | null;
  source: string | null;
  /** Present exactly when `price` is null. */
  skipped?: string;
}

export interface BulkAllocateResult {
  allocated: Array<{ inventoryItemId: string; name: string; price: number }>;
  skipped: Array<{ inventoryItemId: string; name: string; reason: string }>;
  problems: Array<{ inventoryItemId: string; name?: string; message: string }>;
}

/**
 * Which source's figure to price from, in preference order.
 *
 * The same order the repricing sweep uses, so an allocation created here and
 * one repriced later agree about which market they are following. tcgcsv first
 * because it is the marketplace this operator's prices are compared against.
 */
const PRICE_SOURCE_ORDER = ['tcgcsv', 'scryfall'] as const;

@Injectable()
export class BulkAllocateService {
  private readonly logger = new Logger(BulkAllocateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /** What {@link allocate} would do, without doing any of it. */
  async preview(
    channelInstanceId: string,
    inventoryItemIds: readonly string[],
  ): Promise<BulkAllocationRow[]> {
    const { rows } = await this.plan(channelInstanceId, inventoryItemIds);
    return rows;
  }

  /**
   * Create a pooled allocation on the channel for each priceable item.
   *
   * Pooled, not fixed: a fixed partition reserves stock for one channel, which
   * is a decision about how to split inventory and not something a bulk action
   * should make on the operator's behalf. Pooled mirrors the pool, which is
   * what "also sell these here" means.
   *
   * Sequential, because `upsertAllocation` takes the optimistic-locking path
   * and two writes to one item would contend; one failure is reported and the
   * rest still land, as every batch here works.
   */
  async allocate(
    channelInstanceId: string,
    inventoryItemIds: readonly string[],
    actorUserId?: string,
  ): Promise<BulkAllocateResult> {
    const { rows, channelName } = await this.plan(channelInstanceId, inventoryItemIds);

    const result: BulkAllocateResult = { allocated: [], skipped: [], problems: [] };

    for (const row of rows) {
      if (row.price === null) {
        result.skipped.push({
          inventoryItemId: row.inventoryItemId,
          name: row.name,
          reason: row.skipped ?? 'no price could be derived',
        });
        continue;
      }

      try {
        await this.inventory.upsertAllocation(row.inventoryItemId, {
          channelInstanceId,
          mode: 'pooled',
          maxQuantity: null,
          price: row.price,
        });
        result.allocated.push({
          inventoryItemId: row.inventoryItemId,
          name: row.name,
          price: row.price,
        });
      } catch (error) {
        result.problems.push({
          inventoryItemId: row.inventoryItemId,
          name: row.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `Bulk allocation to "${channelName}" by ${actorUserId ?? 'unknown'}: ` +
        `${result.allocated.length} allocated, ${result.skipped.length} skipped, ` +
        `${result.problems.length} problem(s).`,
    );

    return result;
  }

  /**
   * The decision, shared by both paths so a preview cannot disagree with what
   * a run then does.
   */
  private async plan(
    channelInstanceId: string,
    inventoryItemIds: readonly string[],
  ): Promise<{ rows: BulkAllocationRow[]; channelName: string }> {
    const ids = [...new Set(inventoryItemIds)];

    if (ids.length === 0) {
      throw new BadRequestException('Select at least one item to add.');
    }
    if (ids.length > MAX_ITEMS) {
      throw new BadRequestException(
        `${ids.length} items is more than one run may add. Select at most ${MAX_ITEMS}.`,
      );
    }

    const channel = await this.prisma.channelInstance.findUnique({
      where: { id: channelInstanceId },
      select: { displayName: true, repricingPolicy: true },
    });
    if (!channel) throw new BadRequestException('No such channel.');

    const policy = parseRepricingPolicy(channel.repricingPolicy);

    const items = await this.prisma.inventoryItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        allocations: { select: { channelInstanceId: true } },
        sku: {
          select: {
            condition: true,
            printing: true,
            catalogItem: {
              select: {
                name: true,
                setName: true,
                marketPrices: {
                  select: { source: true, printing: true, price: true },
                },
              },
            },
          },
        },
      },
    });

    const rows = items.map((item): BulkAllocationRow => {
      const { sku } = item;
      const base = {
        inventoryItemId: item.id,
        name: sku.catalogItem.name,
        setName: sku.catalogItem.setName,
        condition: sku.condition,
        printing: sku.printing,
      };

      if (item.allocations.some((a) => a.channelInstanceId === channelInstanceId)) {
        return {
          ...base,
          price: null,
          marketPrice: null,
          source: null,
          skipped: 'already on this channel',
        };
      }

      // Per printing, deliberately: a foil priced off the plain printing's
      // market is the wrong price with no error, which is why the sweep records
      // figures per printing in the first place.
      const forPrinting = sku.catalogItem.marketPrices.filter((p) => p.printing === sku.printing);
      const figure = PRICE_SOURCE_ORDER.map((source) =>
        forPrinting.find((p) => p.source === source),
      ).find((p) => p !== undefined);

      if (!figure) {
        return {
          ...base,
          price: null,
          marketPrice: null,
          source: null,
          skipped: 'no market price recorded yet — repricing has never priced this item',
        };
      }

      const price = targetPrice(policy, sku.condition, figure.price);
      if (price === undefined) {
        return {
          ...base,
          price: null,
          marketPrice: figure.price,
          source: figure.source,
          skipped: `this channel declares no percentage of market for ${sku.condition}`,
        };
      }

      return { ...base, price, marketPrice: figure.price, source: figure.source };
    });

    // Ordered as the caller asked, so the preview reads in the same order as
    // the rows they ticked.
    const byId = new Map(rows.map((r) => [r.inventoryItemId, r]));
    return {
      rows: ids.flatMap((id) => byId.get(id) ?? []),
      channelName: channel.displayName,
    };
  }
}
