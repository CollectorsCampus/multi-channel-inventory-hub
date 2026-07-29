import { createHash } from 'node:crypto';
import type {
  Connector,
  Ctx,
  ExportListingsRequest,
  ExportedFile,
  ImportProblem,
  ImportResult,
  ImportedFile,
  LiveListingState,
  NormalizedEvent,
} from '@hub/connector-sdk';
import { findHeader, parseCsv, parseMoneyToCents, parseQuantity, toCsv } from './csv';
import { formatCondition, parseCondition } from './condition';
import { MY_PRICING, PULL_SHEET, describeMismatch, matchFormat } from './formats';

/**
 * TCGPlayer as a **file-based** connector (ADR 0002).
 *
 * TCGPlayer closed its developer programme to new applicants, so this channel
 * cannot call an API. Instead it renders a CSV the operator uploads to
 * TCGPlayer Pro, and ingests the pricing and pull-sheet exports they download
 * back.
 *
 * That makes it a `manual` channel: its data is only as current as the last
 * round trip a human performed. The core knows this from the declared
 * capabilities and presents it accordingly, and reconciliation must not read
 * that staleness as drift.
 *
 * ## What the operator has to know
 *
 * A pull sheet lists orders **awaiting fulfilment**, not a sales history.
 * Shipped orders drop off it. An operator who ships before uploading never
 * records those sales here, and nothing recovers a missed upload except
 * inventory reconciliation. Re-uploading is always safe — every sale carries a
 * stable idempotency key — so uploading too often is the correct habit.
 *
 * ## What is deliberately never read
 *
 * `ShippingExport` and `PackingSlips` carry customers' full names and postal
 * addresses. Neither is a format this connector knows how to parse, and that is
 * the point: an operator who uploads one gets a rejection naming the file we
 * wanted, and their buyers' addresses never enter the database.
 */

export const TCGPLAYER_CONNECTOR_KEY = 'tcgplayer';

export function createTcgPlayerConnector(): Connector {
  return {
    key: TCGPLAYER_CONNECTOR_KEY,
    displayName: 'TCGPlayer',
    description:
      'File-based sync for TCGPlayer Pro. Download a pricing CSV to upload to TCGPlayer, and ' +
      'upload their PullSheet back here to record sales. TCGPlayer no longer issues API keys.',

    configSchema: {
      type: 'object',
      properties: {
        sellerName: {
          type: 'string',
          title: 'Seller name',
          description: 'Only used to label exported files. Optional.',
        },
      },
    },

    // No credentials: there is no API to authenticate against. The operator's
    // TCGPlayer login stays entirely on their side of the round trip.
    secretFields: [],

    capabilities: ['listing.export', 'orders.import', 'inventory.import'],

    // Nothing here talks to a network, so there is no remote allowance to
    // respect. The core still expects a declared limit, and one file operation a
    // second is well past what a human can trigger.
    rateLimit: { requestsPerSecond: 1, burst: 1 },

    // -----------------------------------------------------------------------
    // listing.export
    // -----------------------------------------------------------------------

    /**
     * Render current listings as a `MyPricing`-shaped CSV for the operator to
     * upload to TCGPlayer Pro.
     *
     * **This is a price export. It deliberately moves no stock.**
     *
     * TCGPlayer's own documentation settles why (read 2026-07-29, and recorded
     * in CLAUDE.md): `Add to Quantity` is the only editable quantity field and
     * it is a *delta* — "a positive number will add that amount to your
     * quantity" — while `Total Quantity` sits under "do not change any of the
     * values in the columns underneath these headings". There is no way to say
     * "set this listing to 4" in their CSV format at all.
     *
     * A delta could be computed, and is refused on purpose: it would not be
     * idempotent. Uploading the same file twice would apply it twice, and the
     * whole file-transport design — down to the wording on the channel card —
     * rests on re-uploading being harmless. An operator who cannot re-upload
     * safely has to remember what they have already sent, which is precisely
     * the bookkeeping this application exists to remove.
     *
     * So `Add to Quantity` is a literal `0`, which their documentation defines
     * as "no changes to your quantity", and the file's job is price. Quantity
     * flows the other way: `inventory.import` reads what TCGPlayer holds, and
     * reconciliation reports the difference.
     */
    async exportListings(ctx: Ctx, req: ExportListingsRequest): Promise<ExportedFile> {
      const rows: Array<Record<string, string>> = [];
      let skipped = 0;

      for (const listing of req.listings) {
        // No TCGPlayer id means this allocation has never been mapped to a
        // listing. Matching on name would be a guess about which of several
        // printings and conditions the seller meant, so it is skipped.
        if (!listing.externalListingId) {
          skipped++;
          continue;
        }

        // `TCG Marketplace Price` is required by their validator and must be
        // 0.01 or greater. A row without one fails validation, and one bad row
        // is enough to make an operator fix the file by hand — so an unpriced
        // allocation is left out rather than sent to be rejected.
        if (listing.price === null || listing.price < 1) {
          ctx.logger.warn(
            `Skipping listing ${listing.externalListingId}: TCGPlayer requires a price of at ` +
              `least 0.01 and this allocation has none.`,
            { allocationId: listing.allocationId },
          );
          skipped++;
          continue;
        }

        const condition = formatCondition(listing.sku);
        if (!condition.ok) {
          // Rather than emit a Condition TCGPlayer will not match, leave the row
          // out and say why. An unmatched row is a silent no-op on their side.
          ctx.logger.warn(`Skipping listing ${listing.externalListingId}: ${condition.reason}`, {
            allocationId: listing.allocationId,
          });
          skipped++;
          continue;
        }

        rows.push({
          'TCGplayer Id': listing.externalListingId,
          'Product Line': listing.sku.game ?? '',
          'Set Name': listing.sku.setName ?? '',
          'Product Name': listing.sku.name,
          Title: '',
          Number: '',
          Rarity: '',
          Condition: condition.value,
          'TCG Market Price': '',
          'TCG Direct Low': '',
          'TCG Low Price With Shipping': '',
          'TCG Low Price': '',
          // Reference-only on their side and ignored on import. Filled with what
          // we believe they are already showing, which is what the column means
          // — putting our *desired* quantity here would read, to anyone opening
          // the file in a spreadsheet, as a change that is never going to happen.
          'Total Quantity': String(listing.listedQuantity),
          // Their documentation: "A 0 will result in no changes to your quantity."
          'Add to Quantity': '0',
          'TCG Marketplace Price': listing.price === null ? '' : formatMoney(listing.price),
          'Photo URL': '',
        });
      }

      if (skipped > 0) {
        ctx.logger.info(
          `Export omitted ${skipped} listing(s): no TCGPlayer id, no price, or a condition ` +
            `TCGPlayer has no spelling for.`,
        );
      }

      const seller = String(ctx.config.sellerName ?? '').trim();
      const stamp = new Date().toISOString().slice(0, 10);

      return {
        filename: `tcgplayer-pricing-${seller ? `${slug(seller)}-` : ''}${stamp}.csv`,
        contentType: 'text/csv',
        content: Buffer.from(toCsv(MY_PRICING_HEADERS, rows, { quoteValues: true }), 'utf8'),
      };
    },

    // -----------------------------------------------------------------------
    // orders.import
    // -----------------------------------------------------------------------

    /**
     * Turn a `PullSheet` into sale events.
     *
     * The load-bearing column is `Order Quantity`, which despite its name is not
     * a quantity: it holds `<order#>:<qty>` pairs, pipe-separated across every
     * order containing that SKU —
     * `AAAA-1111-AAAA:6 | AAAA-2222-BBBB:2`. Splitting it is the only reason
     * line-item sales can be recovered from a file at all, and it is what gives
     * each sale a key stable enough to re-upload against.
     */
    async importOrders(_ctx: Ctx, file: ImportedFile): Promise<ImportResult<NormalizedEvent>> {
      const table = parseCsv(file.content.toString('utf8'));
      const match = matchFormat(table, PULL_SHEET);

      if (!match.ok) {
        return {
          records: [],
          problems: [{ message: describeMismatch(PULL_SHEET, match.missing, table.headers) }],
        };
      }

      const records: NormalizedEvent[] = [];
      const problems: ImportProblem[] = [...unexpectedColumnProblems(match.unexpected)];
      const { columns } = match;
      const describeRow = rowLabeller(table.headers);

      table.rows.forEach((row, index) => {
        const line = index + 2; // +1 for the header row, +1 for 1-based numbering.
        const skuId = row[columns.skuId] ?? '';
        const label = describeRow(row, line);

        // A real pull sheet ends with a trailer: `Orders Contained in Pull
        // Sheet:` followed by every order number, pipe-separated, in what would
        // be the Product Name column. It carries no SkuId, no quantity and no
        // order column, so there is no sale hiding in it — and reporting it
        // would put a spurious complaint on every single import an operator
        // ever does, which is how a problem list stops being read.
        if (isNotADataRow(row, [columns.skuId, columns.quantity, columns.orderQuantity])) {
          return;
        }

        if (!skuId) {
          problems.push({ line, message: `${label} has no SkuId, so it maps to no listing.` });
          return;
        }

        // Parsed for its own sake: a Condition we cannot read means our
        // understanding of the file is incomplete, and the operator should hear
        // about it. It does not block the sale, because the row's identity is
        // the SkuId and a real sale is worse to lose than to flag.
        reportCondition(problems, line, label, row[columns.condition] ?? '');

        const parsed = parseOrderQuantity(row[columns.orderQuantity] ?? '');
        if (parsed.pairs.length === 0) {
          problems.push({
            line,
            message:
              `${label} has no readable order reference in Order Quantity ` +
              `("${row[columns.orderQuantity] ?? ''}"), so the sale cannot be attributed.`,
          });
          return;
        }
        for (const problem of parsed.problems) {
          problems.push({ line, message: `${label}: ${problem}` });
        }

        // Every row of a real export satisfies this. A row that does not means
        // the format has changed under us, so it is reported — but the pairs are
        // the primary data and `Quantity` is the derived total, so the sales are
        // still recorded rather than silently dropped.
        const stated = parseQuantity(row[columns.quantity]);
        const summed = parsed.pairs.reduce((total, pair) => total + pair.quantity, 0);
        if (stated !== undefined && stated !== summed) {
          problems.push({
            line,
            message:
              `${label}: Quantity is ${stated} but the per-order quantities sum to ${summed}. ` +
              `Recorded the per-order values.`,
          });
        }

        for (const pair of parsed.pairs) {
          records.push({
            type: 'sale',
            externalListingId: skuId,
            quantity: pair.quantity,
            orderReference: pair.orderNumber,
            externalEventId: saleKey(pair.orderNumber, skuId),
          });
        }
      });

      return { records, problems };
    },

    // -----------------------------------------------------------------------
    // inventory.import
    // -----------------------------------------------------------------------

    /**
     * Turn a `MyPricing` export into live listing state.
     *
     * **Quantity 0 is not an error and not a deletion.** 563 of 1333 rows in a
     * real export are zero — they mean "priced but not stocked" — so they are
     * reported as live state with quantity 0 and `active` true. Dropping them
     * would make reconciliation see a listing vanish; calling them inactive
     * would make it see a delisting. Neither happened.
     */
    async importInventory(_ctx: Ctx, file: ImportedFile): Promise<ImportResult<LiveListingState>> {
      const table = parseCsv(file.content.toString('utf8'));
      const match = matchFormat(table, MY_PRICING);

      if (!match.ok) {
        return {
          records: [],
          problems: [{ message: describeMismatch(MY_PRICING, match.missing, table.headers) }],
        };
      }

      const records: LiveListingState[] = [];
      const problems: ImportProblem[] = [...unexpectedColumnProblems(match.unexpected)];
      const { columns } = match;
      const describeRow = rowLabeller(table.headers);

      table.rows.forEach((row, index) => {
        const line = index + 2;
        const id = row[columns.tcgplayerId] ?? '';
        const label = describeRow(row, line);

        // Symmetry with the pull sheet, which really does carry a trailer row.
        // A real pricing export has not been seen to, but a row with neither an
        // id nor a quantity says nothing either way.
        if (isNotADataRow(row, [columns.tcgplayerId, columns.totalQuantity])) return;

        if (!id) {
          problems.push({ line, message: `${label} has no TCGplayer Id.` });
          return;
        }

        reportCondition(problems, line, label, row[columns.condition] ?? '');

        const quantity = parseQuantity(row[columns.totalQuantity]);
        if (quantity === undefined || quantity < 0) {
          problems.push({
            line,
            message: `${label} has no usable Total Quantity ("${row[columns.totalQuantity] ?? ''}").`,
          });
          return;
        }

        const price = parseMoneyToCents(row[columns.marketplacePrice]);

        records.push({
          externalListingId: id,
          quantity,
          ...(price === undefined ? {} : { price, currency: 'USD' }),
          // TCGPlayer keeps a priced-but-unstocked row listed, so presence in
          // this export is what "active" means. Quantity says nothing about it.
          active: true,
        });
      });

      return { records, problems };
    },
  };
}

// ---------------------------------------------------------------------------
// Order Quantity
// ---------------------------------------------------------------------------

export interface OrderQuantityPair {
  orderNumber: string;
  quantity: number;
}

/**
 * Split `Order Quantity` into its `<order#>:<qty>` pairs.
 *
 * Exported because it is the one piece of this format nobody would guess from
 * the header, and it deserves to be testable on its own.
 */
export function parseOrderQuantity(raw: string): {
  pairs: OrderQuantityPair[];
  problems: string[];
} {
  const pairs: OrderQuantityPair[] = [];
  const problems: string[] = [];

  for (const part of raw.split('|')) {
    const chunk = part.trim();
    if (chunk === '') continue;

    // Split on the last colon: an order number has none today, but assuming
    // that of somebody else's identifier format is a cheap way to be wrong.
    const separator = chunk.lastIndexOf(':');
    if (separator === -1) {
      problems.push(`could not read order entry "${chunk}"`);
      continue;
    }

    const orderNumber = chunk.slice(0, separator).trim();
    const quantity = parseQuantity(chunk.slice(separator + 1));

    if (orderNumber === '') {
      problems.push(`order entry "${chunk}" has no order number`);
      continue;
    }
    if (quantity === undefined || quantity <= 0) {
      problems.push(`order ${orderNumber} has no usable quantity`);
      continue;
    }

    pairs.push({ orderNumber, quantity });
  }

  return { pairs, problems };
}

/**
 * Idempotency key for one sale.
 *
 * Order number plus SKU, and deliberately **not** quantity. A pull sheet is a
 * snapshot of what is still awaiting fulfilment, so part-shipping an order
 * changes the quantity on the next download — and a key including it would read
 * the same sale as a new one and decrement stock twice. Order and SKU together
 * identify the line for as long as it exists.
 */
export function saleKey(orderNumber: string, skuId: string): string {
  return createHash('sha256')
    .update(`tcgplayer:${orderNumber}:${skuId}`)
    .digest('hex')
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MY_PRICING_HEADERS = [
  'TCGplayer Id',
  'Product Line',
  'Set Name',
  'Product Name',
  'Title',
  'Number',
  'Rarity',
  'Condition',
  'TCG Market Price',
  'TCG Direct Low',
  'TCG Low Price With Shipping',
  'TCG Low Price',
  'Total Quantity',
  'Add to Quantity',
  'TCG Marketplace Price',
  'Photo URL',
];

/**
 * True when a row cannot be a data row at all.
 *
 * Structural rather than a match on the trailer's wording, which TCGPlayer is
 * free to reword: if every column that could identify or quantify something is
 * empty, there is nothing to import and nothing to lose by skipping it. A row
 * with an order reference but no SkuId is deliberately *not* caught here — that
 * is a sale we cannot attribute, and it must be reported.
 */
function isNotADataRow(row: Record<string, string>, required: string[]): boolean {
  return required.every((column) => (row[column] ?? '').trim() === '');
}

/**
 * Report a Condition we cannot read, without discarding the row.
 *
 * An empty Condition is real data — TCGPlayer emits them — so it is silent. A
 * non-empty one we cannot parse is always reported and never guessed at: a
 * parser that shrugs and assumes English files a Japanese card as an English
 * one, and the seller finds out from an angry buyer.
 */
function reportCondition(
  problems: ImportProblem[],
  line: number,
  label: string,
  raw: string,
): void {
  const parsed = parseCondition(raw);
  if (parsed.status === 'unrecognised') {
    problems.push({
      line,
      message: `${label}: could not read Condition "${parsed.raw}" — ${parsed.detail}.`,
    });
  }
}

/**
 * One problem for the whole file, not one per row.
 *
 * A new column in TCGPlayer's export is worth knowing about and is not worth
 * a thousand identical lines.
 */
function unexpectedColumnProblems(unexpected: string[]): ImportProblem[] {
  if (unexpected.length === 0) return [];
  return [
    {
      message:
        `This export has column(s) we do not recognise: ${unexpected.join(', ')}. ` +
        `They were ignored. TCGPlayer's export format may have changed.`,
    },
  ];
}

/**
 * Build a row labeller for problem messages.
 *
 * The line number alone sends an operator counting rows in a spreadsheet; the
 * product name tells them which card. `Product Name` is not a required column —
 * we only read it to say this — so the labeller degrades to the line number
 * rather than the import failing over a cosmetic field.
 */
function rowLabeller(headers: string[]): (row: Record<string, string>, line: number) => string {
  const header = findHeader(headers, ['Product Name']);
  return (row, line) => {
    const name = header ? row[header]?.trim() : undefined;
    return name ? `Row ${line} (${name})` : `Row ${line}`;
  };
}

/** Cents to the decimal string TCGPlayer expects. Never touches a float. */
export function formatMoney(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
