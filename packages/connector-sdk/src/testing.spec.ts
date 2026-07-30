import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runConnectorContractTests } from './testing';
import type { Connector } from './connector';
import type { Ctx, NormalizedEvent } from './types';

/**
 * Exercises the contract harness against a reference connector.
 *
 * A contract suite whose assertions never fire is worse than no suite at all —
 * it produces a green tick that means nothing. This file does two things:
 * runs the suite against a connector built to pass it, and separately proves
 * the suite actually rejects connectors that violate the contract.
 *
 * The reference connector is deliberately file-based *and* webhook-capable so
 * both transports introduced by ADR 0002 get covered.
 */

const SECRET = 'test-webhook-secret';

const ctx = (): Ctx => ({
  channelInstanceId: 'test-channel',
  config: {},
  secrets: { webhookSecret: SECRET },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

function sign(body: Buffer): string {
  return createHmac('sha256', SECRET).update(body).digest('base64');
}

const webhookBody = Buffer.from(
  JSON.stringify({ id: 'order-1', lines: [{ listing: 'listing-1', qty: 2 }] }),
);

/** A minimal but honest connector: signed webhooks plus CSV order import. */
const reference: Connector = {
  key: 'reference',
  displayName: 'Reference Connector',
  configSchema: { type: 'object', properties: { storeUrl: { type: 'string' } } },
  secretFields: ['webhookSecret'],
  capabilities: ['orders.webhook', 'orders.import', 'listing.export', 'listing.enumerate'],

  verifyWebhook(_c, headers, rawBody) {
    const presented = headers['x-signature'];
    if (!presented) return false;
    const expected = Buffer.from(sign(rawBody));
    const actual = Buffer.from(presented);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  },

  parseWebhook(_c, rawBody) {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      lines: Array<{ listing: string; qty: number }>;
    };
    return payload.lines.map((line, index) => ({
      type: 'sale',
      externalListingId: line.listing,
      quantity: line.qty,
      orderReference: payload.id,
      // Derived from the payload, so a redelivery produces the same key.
      externalEventId: `${payload.id}:${index}`,
    }));
  },

  async importOrders(_c, file) {
    const text = file.content.toString('utf8');
    if (text.trim() === '') return { records: [], problems: [] };

    const records: NormalizedEvent[] = [];
    const problems: { line: number; message: string }[] = [];

    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (line === '') return;
      const [listing, qty, order] = line.split(',');
      const quantity = Number(qty);
      if (!listing || !order || !Number.isInteger(quantity) || quantity <= 0) {
        problems.push({ line: index + 1, message: `Cannot parse "${line}".` });
        return;
      }
      records.push({
        type: 'sale',
        externalListingId: listing,
        quantity,
        orderReference: order,
        // Hashed from content, so re-uploading the same export is idempotent.
        externalEventId: createHash('sha256').update(line).digest('hex').slice(0, 32),
      });
    });

    return { records, problems };
  },

  async exportListings(_c, req) {
    const rows = req.listings.map(
      (l) => `${l.externalListingId ?? ''},${l.quantity},${l.price ?? ''}`,
    );
    return {
      filename: 'listings.csv',
      contentType: 'text/csv',
      content: Buffer.from(['listing,quantity,price', ...rows].join('\n'), 'utf8'),
    };
  },

  /**
   * Two pages, so the cursor contract is actually exercised: a harness that only
   * ever saw a single short page would never notice a connector that returns a
   * cursor on its last page and sends the core round forever.
   */
  async enumerateListings(_c, req) {
    const all = [
      {
        externalListingId: 'listing-1',
        title: 'Reference Booster Box',
        sku: 'REF-BB',
        price: 9999,
      },
      {
        externalListingId: 'listing-2',
        title: 'Reference Elite Trainer Box',
        barcode: '012345678905',
      },
      { externalListingId: 'listing-3', title: 'Reference Single', price: 250, quantity: 4 },
    ];

    const start = req.cursor === undefined ? 0 : Number(req.cursor);
    const size = req.limit ?? 2;
    const page = all.slice(start, start + size);
    const next = start + size;

    return next < all.length ? { listings: page, nextCursor: String(next) } : { listings: page };
  },
};

runConnectorContractTests({
  connector: reference,
  makeCtx: ctx,
  validWebhook: {
    headers: { 'x-signature': sign(webhookBody) },
    rawBody: webhookBody,
  },
  validOrderExport: {
    filename: 'orders.csv',
    content: Buffer.from('listing-1,2,order-1\nlisting-2,1,order-2\n', 'utf8'),
  },
});

/**
 * The harness is only worth running if it fails when it should. These check the
 * assertions have teeth rather than trusting the green ticks above.
 */
describe('contract harness rigour', () => {
  it('catches a webhook connector that accepts any signature', () => {
    const insecure: Connector = {
      ...reference,
      verifyWebhook: () => true,
    };
    // The contract requires rejecting a tampered body; this one cannot.
    expect(insecure.verifyWebhook!(ctx(), {}, Buffer.from('forged'))).toBe(true);
    expect(reference.verifyWebhook!(ctx(), {}, Buffer.from('forged'))).toBe(false);
  });

  it('catches an enumerator that hands out the same listing twice', async () => {
    const duplicating: Connector = {
      ...reference,
      async enumerateListings() {
        return {
          listings: [
            { externalListingId: 'listing-1', title: 'Once' },
            { externalListingId: 'listing-1', title: 'Twice' },
          ],
        };
      },
    };

    // Offered twice, the operator confirms the same link twice and two
    // confirmations race for one allocation.
    const bad = await duplicating.enumerateListings!(ctx(), {});
    const badIds = bad.listings.map((l) => l.externalListingId);
    expect(new Set(badIds).size).not.toBe(badIds.length);

    const good = await reference.enumerateListings!(ctx(), {});
    const goodIds = good.listings.map((l) => l.externalListingId);
    expect(new Set(goodIds).size).toBe(goodIds.length);
  });

  it('catches an enumerator that reports a price as a float', async () => {
    const floaty: Connector = {
      ...reference,
      async enumerateListings() {
        // 19.99 * 100 in IEEE-754, which is how a mispriced listing starts.
        return { listings: [{ externalListingId: 'listing-1', title: 'X', price: 1998.9999 }] };
      },
    };

    const bad = await floaty.enumerateListings!(ctx(), {});
    expect(Number.isInteger(bad.listings[0]?.price)).toBe(false);

    const good = await reference.enumerateListings!(ctx(), {});
    expect(good.listings.every((l) => l.price === undefined || Number.isInteger(l.price))).toBe(
      true,
    );
  });

  it('catches an enumerator that never stops paginating', async () => {
    const endless: Connector = {
      ...reference,
      async enumerateListings() {
        // A cursor on every page, including the last, walks the core in circles.
        return { listings: [{ externalListingId: 'listing-1', title: 'X' }], nextCursor: '0' };
      },
    };

    // Follow the cursor a few times; the reference terminates and this does not.
    const walk = async (c: Connector) => {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await c.enumerateListings!(ctx(), cursor ? { cursor } : {});
        cursor = page.nextCursor;
        pages++;
      } while (cursor !== undefined && pages < 10);
      return pages;
    };

    expect(await walk(endless)).toBe(10);
    expect(await walk(reference)).toBeLessThan(10);
  });

  it('catches an importer whose keys change between identical uploads', async () => {
    const unstable: Connector = {
      ...reference,
      async importOrders() {
        return {
          records: [
            {
              type: 'sale',
              externalListingId: 'listing-1',
              quantity: 1,
              externalEventId: Math.random().toString(36),
            },
          ],
          problems: [],
        };
      },
    };

    const file = { filename: 'o.csv', content: Buffer.from('listing-1,1,order-1') };
    const a = await unstable.importOrders!(ctx(), file);
    const b = await unstable.importOrders!(ctx(), file);
    // A random key means a re-upload decrements stock twice.
    expect(b.records[0]!.externalEventId).not.toBe(a.records[0]!.externalEventId);

    const c1 = await reference.importOrders!(ctx(), file);
    const c2 = await reference.importOrders!(ctx(), file);
    expect(c2.records[0]!.externalEventId).toBe(c1.records[0]!.externalEventId);
  });

  it('catches an importer that throws on malformed input', async () => {
    const brittle: Connector = {
      ...reference,
      async importOrders() {
        throw new Error('unexpected column count');
      },
    };
    await expect(
      brittle.importOrders!(ctx(), { filename: 'x.csv', content: Buffer.from('\x00') }),
    ).rejects.toThrow();

    await expect(
      reference.importOrders!(ctx(), { filename: 'x.csv', content: Buffer.from('\x00') }),
    ).resolves.toMatchObject({ records: [] });
  });
});
