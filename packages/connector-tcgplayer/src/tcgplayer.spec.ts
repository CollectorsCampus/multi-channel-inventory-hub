import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx, ImportedFile, LiveListingState, SaleEvent } from '@hub/connector-sdk';
import { runConnectorContractTests } from '@hub/connector-sdk/testing';
import { createTcgPlayerConnector, parseOrderQuantity, saleKey } from './tcgplayer';
import { parseCsv } from './csv';

/**
 * Everything here runs against redacted fixtures of real exports, never a live
 * account — which is the only reason this connector could be built at all
 * (ADR 0002). The fixtures preserve every shape the real files contain,
 * including the two different line endings, an empty Condition, quantity-0 rows
 * and a card name containing an escaped quote.
 */

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)));

const MY_PRICING: ImportedFile = { filename: 'MyPricing.csv', content: fixture('my-pricing.csv') };
const PULL_SHEET: ImportedFile = { filename: 'PullSheet.csv', content: fixture('pull-sheet.csv') };

const logged: string[] = [];

function makeCtx(config: Record<string, unknown> = {}): Ctx {
  return {
    channelInstanceId: 'channel-1',
    config,
    secrets: Object.freeze({}),
    logger: {
      debug: () => {},
      info: (message) => logged.push(message),
      warn: (message) => logged.push(message),
      error: (message) => logged.push(message),
    },
  };
}

beforeEach(() => {
  logged.length = 0;
});

const connector = createTcgPlayerConnector();

// The shared suite every connector must pass, bundled or community.
runConnectorContractTests({
  connector,
  makeCtx: () => makeCtx(),
  validOrderExport: PULL_SHEET,
});

// ---------------------------------------------------------------------------

describe('declaration', () => {
  it('is a manual channel, since a human moves every byte', () => {
    // The UI must not present this as if it were live, and reconciliation must
    // not read its staleness as drift.
    expect(connector.capabilities).toEqual(['listing.export', 'orders.import', 'inventory.import']);
  });

  it('asks for no credentials, because there is nothing to authenticate against', () => {
    expect(connector.secretFields).toEqual([]);
  });

  /**
   * The previous draft of this connector exposed operator-editable column
   * names. That surface let someone point the quantity column at a price
   * column and silently rewrite their own stock, and it existed only because
   * the real headers were unknown. They are known now.
   */
  it('exposes no column-mapping settings', () => {
    const properties = Object.keys(connector.configSchema.properties ?? {});
    expect(properties).toEqual(['sellerName']);
  });
});

// ---------------------------------------------------------------------------

describe('parseOrderQuantity', () => {
  /**
   * The single most surprising thing about this format: the column named
   * `Order Quantity` is not a quantity. Without splitting it there is no
   * line-item sales source for TCGPlayer at all.
   */
  it('splits pipe-separated order:quantity pairs', () => {
    expect(parseOrderQuantity('AAAA-1111-AAAA:6 | AAAA-2222-BBBB:2').pairs).toEqual([
      { orderNumber: 'AAAA-1111-AAAA', quantity: 6 },
      { orderNumber: 'AAAA-2222-BBBB', quantity: 2 },
    ]);
  });

  it('reads a single pair with no pipe', () => {
    expect(parseOrderQuantity('AAAA-1111-AAAA:1').pairs).toEqual([
      { orderNumber: 'AAAA-1111-AAAA', quantity: 1 },
    ]);
  });

  it('reports an entry it cannot read rather than dropping it silently', () => {
    const result = parseOrderQuantity('AAAA-1111-AAAA:1 | nonsense');
    expect(result.pairs).toHaveLength(1);
    expect(result.problems).toHaveLength(1);
  });

  it('refuses a zero or negative quantity', () => {
    expect(parseOrderQuantity('AAAA-1111-AAAA:0').pairs).toEqual([]);
    expect(parseOrderQuantity('AAAA-1111-AAAA:-2').pairs).toEqual([]);
  });

  it('returns nothing for an empty column', () => {
    expect(parseOrderQuantity('').pairs).toEqual([]);
    expect(parseOrderQuantity('   ').pairs).toEqual([]);
  });
});

describe('saleKey', () => {
  /**
   * A pull sheet lists orders *awaiting fulfilment*. Part-ship an order and the
   * quantity on the next download is smaller — so a key derived from the
   * quantity would read the same sale as a new one and decrement stock twice.
   */
  it('does not change when the quantity does', () => {
    expect(saleKey('AAAA-1111-AAAA', '1000004')).toBe(saleKey('AAAA-1111-AAAA', '1000004'));
  });

  it('separates two SKUs within one order', () => {
    expect(saleKey('AAAA-1111-AAAA', '1000004')).not.toBe(saleKey('AAAA-1111-AAAA', '1000005'));
  });

  it('separates the same SKU across two orders', () => {
    expect(saleKey('AAAA-1111-AAAA', '1000004')).not.toBe(saleKey('AAAA-2222-BBBB', '1000004'));
  });
});

// ---------------------------------------------------------------------------

describe('orders.import (PullSheet)', () => {
  const sales = async (file = PULL_SHEET) => {
    const result = await connector.importOrders!(makeCtx(), file);
    return { ...result, sales: result.records.filter((e): e is SaleEvent => e.type === 'sale') };
  };

  it('reads one sale per order, not one per row', async () => {
    // The land row carries two orders in a single line. A row-per-sale reading
    // would record one sale of 8 against no particular order, which is both the
    // wrong shape and unattributable.
    const { sales: events } = await sales();
    const land = events.filter((e) => e.externalListingId === '1000004');

    expect(land.map((e) => [e.orderReference, e.quantity])).toEqual([
      ['AAAAAAAA-222222-BBBBB', 6],
      ['AAAAAAAA-333333-CCCCC', 2],
    ]);
  });

  it('uses the SkuId alone as the listing id', async () => {
    // TCGplayer Id and SkuId are SKU-level, not product-level, so no composite
    // key is needed — the same card in two conditions has two different ids.
    const { sales: events } = await sales();
    expect(events.map((e) => e.externalListingId).sort()).toEqual([
      '1000001',
      '1000002',
      '1000004',
      '1000004',
      '1000006',
      '1000007',
      '1000009',
    ]);
  });

  it('records every sale in the fixture', async () => {
    const { sales: events } = await sales();
    expect(events.reduce((total, e) => total + e.quantity, 0)).toBe(23);
  });

  /**
   * An empty Condition appears in real exports. The row still names a SkuId and
   * an order, so the sale is real and losing it would be worse than any
   * cosmetic gap.
   */
  it('still records a sale whose Condition column is empty', async () => {
    const { sales: events, problems } = await sales();
    expect(events.some((e) => e.externalListingId === '1000009')).toBe(true);
    expect(problems.filter((p) => p.line === 6)).toEqual([]);
  });

  it('reports an unreadable Condition without discarding the sale', async () => {
    const tampered = replaceCell(PULL_SHEET, 'Near Mint Holofoil - Japanese', 'Pristine Klingon');
    const { sales: events, problems } = await sales(tampered);

    expect(events.some((e) => e.externalListingId === '1000007')).toBe(true);
    expect(problems.some((p) => /could not read Condition/.test(p.message))).toBe(true);
  });

  it('reports a Quantity that disagrees with the per-order sum, and trusts the pairs', async () => {
    // Verified true of every row in a real export. A row where it stops being
    // true means the format moved under us.
    const tampered = replaceCell(PULL_SHEET, '"8"', '"9"');
    const { sales: events, problems } = await sales(tampered);

    expect(problems.some((p) => /sum to 8/.test(p.message))).toBe(true);
    const land = events.filter((e) => e.externalListingId === '1000004');
    expect(land.reduce((total, e) => total + e.quantity, 0)).toBe(8);
  });

  it('gives every sale a key that survives a re-upload', async () => {
    const first = await sales();
    const second = await sales();
    expect(second.sales.map((e) => e.externalEventId)).toEqual(
      first.sales.map((e) => e.externalEventId),
    );
    expect(new Set(first.sales.map((e) => e.externalEventId)).size).toBe(first.sales.length);
  });

  /**
   * The commonest operator mistake is uploading the right file to the wrong
   * place. Reading a pricing export as orders would attribute no sales and look
   * like a quiet day.
   */
  it('refuses a MyPricing export, naming the file it wanted', async () => {
    const result = await connector.importOrders!(makeCtx(), MY_PRICING);
    expect(result.records).toEqual([]);
    expect(result.problems[0]!.message).toMatch(/PullSheet/);
    expect(result.problems[0]!.message).toMatch(/Order Quantity/);
  });

  /**
   * ShippingExport and PackingSlips carry customers' full names and postal
   * addresses. This connector has no format for either, and an operator who
   * uploads one gets a rejection instead of a database full of addresses.
   */
  it('refuses a shipping export rather than ingesting customer addresses', async () => {
    const shipping = Buffer.from(
      'Order #,First Name,Last Name,Address 1,City,State,Postal Code\n' +
        '"AAAA-1111-AAAA","Jane","Doe","1 Example Street","Springfield","IL","62701"\n',
    );
    const result = await connector.importOrders!(makeCtx(), {
      filename: 'ShippingExport.csv',
      content: shipping,
    });
    expect(result.records).toEqual([]);
    expect(result.problems[0]!.message).toMatch(/does not look like/);
  });

  /**
   * A real pull sheet ends with `Orders Contained in Pull Sheet:` followed by
   * every order number, pipe-separated, in what would be the Product Name
   * column — two fields on a line where the others have eleven. Found by running
   * this connector against a genuine Level 4 seller export; the redacted fixture
   * now carries the same shape.
   *
   * It must be skipped in silence. Reporting it would put a spurious complaint
   * on every import an operator ever performs, which is how a problem list stops
   * being read at all.
   */
  it('skips the trailer row silently rather than reporting it every time', async () => {
    const { sales: events, problems } = await sales();

    expect(problems).toEqual([]);
    expect(events.every((e) => /^\d+$/.test(e.externalListingId))).toBe(true);
  });

  it('still reports a row that has an order but no SkuId', async () => {
    // The structural skip must not swallow a sale we genuinely cannot attribute.
    const orphaned = replaceCell(PULL_SHEET, '"1000009"', '""');
    const { problems } = await sales(orphaned);

    expect(problems.some((p) => /no SkuId/.test(p.message))).toBe(true);
  });

  it('reports a new column once for the file, not once per row', async () => {
    const withExtra = prependHeader(PULL_SHEET, 'Surprise New Column');
    const result = await connector.importOrders!(makeCtx(), withExtra);
    const notices = result.problems.filter((p) => /do not recognise/.test(p.message));
    expect(notices).toHaveLength(1);
    expect(result.records.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('inventory.import (MyPricing)', () => {
  const states = async (file = MY_PRICING): Promise<LiveListingState[]> =>
    (await connector.importInventory!(makeCtx(), file)).records;

  it('reads every row, including the ones with no stock', async () => {
    expect(await states()).toHaveLength(8);
  });

  /**
   * 563 of 1333 rows in a real export are quantity 0. They mean "priced but not
   * stocked", so reconciliation must not read them as a listing that vanished.
   */
  it('reports a quantity-0 row as live with zero stock, not as inactive', async () => {
    const pikachu = (await states()).find((s) => s.externalListingId === '1000005');
    expect(pikachu).toMatchObject({ quantity: 0, active: true });
  });

  it('reads prices at both two and four decimal places as the same cent', async () => {
    const byId = new Map((await states()).map((s) => [s.externalListingId, s]));
    expect(byId.get('1000001')?.price).toBe(1399);
    expect(byId.get('1000004')?.price).toBe(127500);
    expect(byId.get('1000008')?.price).toBe(25);
  });

  it('omits the price rather than inventing one when the column is blank', async () => {
    const blank = replaceCell(MY_PRICING, '"4.9900"', '""');
    const creature = (await states(blank)).find((s) => s.externalListingId === '1000002');
    expect(creature?.price).toBeUndefined();
  });

  it('handles a product name containing an escaped quote', async () => {
    expect((await states()).some((s) => s.externalListingId === '1000008')).toBe(true);
  });

  it('refuses a PullSheet, naming the file it wanted', async () => {
    const result = await connector.importInventory!(makeCtx(), PULL_SHEET);
    expect(result.records).toEqual([]);
    expect(result.problems[0]!.message).toMatch(/MyPricing/);
  });

  it('handles an empty file without throwing', async () => {
    const result = await connector.importInventory!(makeCtx(), {
      filename: 'empty.csv',
      content: Buffer.alloc(0),
    });
    expect(result.records).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('reports a row with no usable quantity and keeps the rest', async () => {
    const tampered = replaceCell(MY_PRICING, '"5","0","13.9900"', '"many","0","13.9900"');
    const result = await connector.importInventory!(makeCtx(), tampered);
    expect(result.records).toHaveLength(7);
    expect(result.problems.some((p) => /Total Quantity/.test(p.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('listing.export', () => {
  const exportRows = async (listings: ExportListing[], config: Record<string, unknown> = {}) => {
    const file = await connector.exportListings!(makeCtx(config), { listings });
    return parseCsv(file.content.toString('utf8'));
  };

  interface ExportListing {
    allocationId: string;
    externalListingId: string | null;
    sku: {
      skuId: string;
      name: string;
      condition: string;
      printing: string;
      language: string;
      game?: string;
      setName?: string;
    };
    quantity: number;
    listedQuantity: number;
    price: number | null;
    currency: string;
  }

  const listing = (overrides: Partial<ExportListing> = {}): ExportListing => ({
    allocationId: 'alloc-1',
    externalListingId: '1000002',
    sku: {
      skuId: 'sku-1',
      name: 'Example Creature, the Wanderer',
      condition: 'NM',
      printing: 'HOLOFOIL',
      language: 'EN',
      game: 'Magic',
      setName: 'Example Set One',
    },
    quantity: 3,
    listedQuantity: 3,
    price: 499,
    currency: 'USD',
    ...overrides,
  });

  it('emits the MyPricing column set, in order', async () => {
    const table = await exportRows([listing()]);
    expect(table.headers).toEqual([
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
    ]);
  });

  it('reproduces the export shape: bare header row, every value quoted, CRLF', async () => {
    const file = await connector.exportListings!(makeCtx(), { listings: [listing()] });
    const text = file.content.toString('utf8');
    expect(text.startsWith('TCGplayer Id,Product Line')).toBe(true);
    expect(text).toContain('\r\n"1000002","Magic"');
  });

  it('recombines the four condition dimensions into TCGPlayer spelling', async () => {
    const table = await exportRows([
      listing({
        sku: {
          ...listing().sku,
          condition: 'MP',
          printing: 'UNLIMITED_HOLOFOIL',
          language: 'JA',
        },
      }),
    ]);
    expect(table.rows[0]!.Condition).toBe('Moderately Played Unlimited Holofoil - Japanese');
  });

  /**
   * TCGPlayer's documented import semantics: `Add to Quantity` is the only
   * editable quantity field and it is a delta — "a 0 will result in no changes
   * to your quantity" — while `Total Quantity` is reference-only.
   *
   * So this export moves no stock, on purpose. A delta could be computed and is
   * refused because it would not be idempotent, and re-uploading being harmless
   * is a property the whole file-transport design depends on.
   */
  it('never moves stock, whatever the ledger says', async () => {
    const table = await exportRows([listing({ quantity: 7, listedQuantity: 2 })]);

    expect(table.rows[0]!['Add to Quantity']).toBe('0');
    // Reference-only on their side; it carries what we believe is already
    // listed, not the desired figure, which would read as a change that is
    // never going to happen.
    expect(table.rows[0]!['Total Quantity']).toBe('2');
  });

  /**
   * `TCG Marketplace Price` is required by their validator and must be 0.01 or
   * greater. One invalid row makes an operator repair the file by hand, so an
   * unpriced allocation is left out rather than sent to be rejected.
   */
  it('omits an allocation with no price, since their validator requires one', async () => {
    const table = await exportRows([listing({ price: null }), listing({ price: 0 })]);
    expect(table.rows).toHaveLength(0);
    expect(logged.join(' ')).toMatch(/at least 0\.01/);
  });

  it('keeps a one-cent price, which is their documented minimum', async () => {
    const table = await exportRows([listing({ price: 1 })]);
    expect(table.rows[0]!['TCG Marketplace Price']).toBe('0.01');
  });

  it('renders cents as a decimal string without touching a float', async () => {
    const table = await exportRows([listing({ price: 127500 })]);
    expect(table.rows[0]!['TCG Marketplace Price']).toBe('1275.00');
  });

  /**
   * Without listing.push there is no way to create a TCGPlayer listing from the
   * hub, so an unmapped allocation has nothing for TCGPlayer to match against.
   * Matching on name would be a guess about which printing and condition the
   * seller meant.
   */
  it('omits an allocation with no TCGPlayer id, and says so', async () => {
    const table = await exportRows([listing(), listing({ externalListingId: null })]);
    expect(table.rows).toHaveLength(1);
    expect(logged.join(' ')).toMatch(/omitted 1 listing/);
  });

  it('omits a listing whose printing has no TCGPlayer spelling, and says why', async () => {
    // ETCHED comes from Scryfall. Emitting a Condition TCGPlayer cannot match
    // would be a silent no-op on their side; omitting it is at least visible.
    const table = await exportRows([listing({ sku: { ...listing().sku, printing: 'ETCHED' } })]);
    expect(table.rows).toHaveLength(0);
    expect(logged.join(' ')).toMatch(/ETCHED/);
  });

  it('labels the file with the date and the configured seller name', async () => {
    const file = await connector.exportListings!(makeCtx({ sellerName: 'Collectors Campus' }), {
      listings: [],
    });
    expect(file.filename).toMatch(/^tcgplayer-pricing-collectors-campus-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.contentType).toBe('text/csv');
  });

  it('round-trips its own export back through inventory.import', async () => {
    // The strongest available check that the emitted shape is the shape we
    // read, short of a live account. The quantity that comes back is the one we
    // believed was listed, because that is what the reference column carries.
    const file = await connector.exportListings!(makeCtx(), {
      listings: [listing({ quantity: 9, listedQuantity: 4, price: 1333 })],
    });
    const result = await connector.importInventory!(makeCtx(), {
      filename: file.filename,
      content: file.content,
    });

    expect(result.problems).toEqual([]);
    expect(result.records).toEqual([
      { externalListingId: '1000002', quantity: 4, price: 1333, currency: 'USD', active: true },
    ]);
  });
});

// ---------------------------------------------------------------------------

/** Byte-level fixture edits, so line endings survive untouched. */
function replaceCell(file: ImportedFile, find: string, replace: string): ImportedFile {
  const text = file.content.toString('utf8');
  if (!text.includes(find)) throw new Error(`Fixture does not contain "${find}"`);
  return { ...file, content: Buffer.from(text.replace(find, replace), 'utf8') };
}

function prependHeader(file: ImportedFile, header: string): ImportedFile {
  const text = file.content.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const [headerRow = '', ...rest] = text.split(eol);
  return {
    ...file,
    content: Buffer.from(
      [`${header},${headerRow}`, ...rest.map((row) => (row === '' ? row : `"",${row}`))].join(eol),
      'utf8',
    ),
  };
}
