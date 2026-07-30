import { describe, expect, it } from 'vitest';
import { validateConnector, type Connector } from './connector';
import { hasCapability } from './capabilities';
import type { Ctx, ImportedFile } from './types';

export { runCatalogSourceContractTests, type CatalogContractOptions } from './catalog-testing';

/**
 * The shared connector contract suite (§10).
 *
 * Every connector — bundled or community — must pass this. It is deliberately
 * also the specification: the rules a connector author has to satisfy are
 * expressed as executable assertions rather than prose that can drift from the
 * implementation.
 *
 * The suite runs against a *mock* platform supplied by the connector's own
 * tests, never a live account. That is what let the TCGPlayer connector be
 * built and verified while its API application sat unapproved, and it is why
 * running the suite costs nothing and risks nothing.
 *
 * Only declared capabilities are exercised. A connector supporting two things
 * well is not penalised against one supporting six badly.
 *
 * ```ts
 * runConnectorContractTests({
 *   connector: makeShopifyConnector(mockClient),
 *   makeCtx: () => ({ channelInstanceId: 'test', config: {...}, secrets: {...}, logger }),
 * });
 * ```
 */
export interface ContractTestOptions {
  connector: Connector;
  /** Fresh context per assertion, wired to the connector's mock platform. */
  makeCtx: () => Ctx;
  /** A signed webhook body the connector should accept, if it does webhooks. */
  validWebhook?: { headers: Record<string, string>; rawBody: Buffer };
  /** An order export the connector should parse, if it does file import. */
  validOrderExport?: ImportedFile;
}

export function runConnectorContractTests(options: ContractTestOptions): void {
  const { connector, makeCtx } = options;

  describe(`connector contract: ${connector.key}`, () => {
    describe('declaration', () => {
      it('declares capabilities consistent with what it implements', () => {
        expect(validateConnector(connector)).toEqual([]);
      });

      it('declares a config schema that is a JSON Schema object', () => {
        expect(connector.configSchema).toBeTypeOf('object');
        // Object schemas are what the settings form renderer can handle; a
        // bare string or array schema has nothing to render fields from.
        expect(connector.configSchema.type ?? 'object').toBe('object');
      });

      it('keeps secrets out of the config schema', () => {
        const properties = Object.keys(connector.configSchema.properties ?? {});
        for (const secret of connector.secretFields ?? []) {
          expect(
            properties,
            `secret "${secret}" must not appear in configSchema — secrets belong in the ` +
              `encrypted credential store, not in channel config`,
          ).not.toContain(secret);
        }
      });

      it('uses a key that is safe in a URL and a filename', () => {
        expect(connector.key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      });
    });

    if (hasCapability(connector.capabilities, 'orders.webhook')) {
      describe('orders.webhook', () => {
        it('rejects a body whose signature does not match', () => {
          const ctx = makeCtx();
          const tampered = Buffer.from('{"tampered":true}');
          const headers = options.validWebhook?.headers ?? {};
          expect(connector.verifyWebhook!(ctx, headers, tampered)).toBe(false);
        });

        it('rejects a body with no signature header at all', () => {
          const ctx = makeCtx();
          const body = options.validWebhook?.rawBody ?? Buffer.from('{}');
          expect(connector.verifyWebhook!(ctx, {}, body)).toBe(false);
        });

        if (options.validWebhook) {
          const signed = options.validWebhook;

          it('accepts a correctly signed body', () => {
            expect(connector.verifyWebhook!(makeCtx(), signed.headers, signed.rawBody)).toBe(true);
          });

          it('gives every parsed event a stable idempotency key', () => {
            const ctx = makeCtx();
            const first = connector.parseWebhook!(ctx, signed.rawBody);
            const second = connector.parseWebhook!(ctx, signed.rawBody);

            for (const event of first) {
              expect(event.externalEventId, 'events need an idempotency key').toBeTruthy();
            }
            // Parsing twice must agree, or a redelivered webhook decrements
            // stock a second time.
            expect(second.map((e) => e.externalEventId)).toEqual(
              first.map((e) => e.externalEventId),
            );
          });

          it('reports only non-negative sale quantities', () => {
            for (const event of connector.parseWebhook!(makeCtx(), signed.rawBody)) {
              if (event.type === 'sale') expect(event.quantity).toBeGreaterThan(0);
            }
          });
        }
      });
    }

    if (hasCapability(connector.capabilities, 'orders.import')) {
      describe('orders.import', () => {
        it('reports malformed input instead of throwing', async () => {
          // One bad line in a thousand-row export must not discard the rest.
          const result = await connector.importOrders!(makeCtx(), {
            filename: 'garbage.csv',
            content: Buffer.from('this,is,not,a,valid,export\n\x00\x01\x02'),
          });
          expect(result.records).toEqual([]);
          expect(result.problems.length).toBeGreaterThan(0);
        });

        it('handles an empty file without throwing', async () => {
          const result = await connector.importOrders!(makeCtx(), {
            filename: 'empty.csv',
            content: Buffer.alloc(0),
          });
          expect(result.records).toEqual([]);
        });

        if (options.validOrderExport) {
          const file = options.validOrderExport;

          it('parses a real export into events with idempotency keys', async () => {
            const result = await connector.importOrders!(makeCtx(), file);
            expect(result.records.length).toBeGreaterThan(0);
            for (const event of result.records) {
              expect(event.externalEventId).toBeTruthy();
            }
          });

          it('produces identical keys when the same file is uploaded twice', async () => {
            // Re-uploading an export is a normal operator mistake. It must not
            // double-decrement.
            const first = await connector.importOrders!(makeCtx(), file);
            const second = await connector.importOrders!(makeCtx(), file);
            expect(second.records.map((e) => e.externalEventId)).toEqual(
              first.records.map((e) => e.externalEventId),
            );
          });
        }
      });
    }

    if (hasCapability(connector.capabilities, 'listing.export')) {
      describe('listing.export', () => {
        it('returns bytes and a filename for an empty listing set', async () => {
          const file = await connector.exportListings!(makeCtx(), { listings: [] });
          expect(Buffer.isBuffer(file.content)).toBe(true);
          expect(file.filename).toBeTruthy();
          expect(file.contentType).toBeTruthy();
        });
      });
    }

    if (hasCapability(connector.capabilities, 'reconcile')) {
      describe('reconcile', () => {
        it('returns an empty array when asked about nothing', async () => {
          await expect(connector.fetchLiveState!(makeCtx(), [])).resolves.toEqual([]);
        });

        it('does not invent state for unknown listing ids', async () => {
          const state = await connector.fetchLiveState!(makeCtx(), ['definitely-not-a-listing']);
          // Omitting an unknown listing is correct; claiming quantity 0 for it
          // would read as drift and trigger a spurious alert.
          expect(state.every((s) => s.externalListingId !== 'definitely-not-a-listing')).toBe(true);
        });
      });
    }

    if (hasCapability(connector.capabilities, 'listing.enumerate')) {
      describe('listing.enumerate', () => {
        it('returns a page with a listings array', async () => {
          const page = await connector.enumerateListings!(makeCtx(), {});
          expect(Array.isArray(page.listings)).toBe(true);
        });

        /**
         * A confirmed match writes `externalListingId` straight onto an
         * allocation, and every later push reads it back. A blank one produces a
         * link that points at nothing and fails on the first sale rather than at
         * confirmation, when someone was watching.
         */
        it('gives every listing a non-empty id and title', async () => {
          const page = await connector.enumerateListings!(makeCtx(), {});

          for (const listing of page.listings) {
            expect(listing.externalListingId).toBeTruthy();
            expect(typeof listing.externalListingId).toBe('string');
            // The operator has to recognise the thing they are confirming.
            expect(listing.title).toBeTruthy();
          }
        });

        it('never repeats an id within a page', async () => {
          const page = await connector.enumerateListings!(makeCtx(), {});
          const ids = page.listings.map((l) => l.externalListingId);

          // Two rows for one listing would offer the operator the same match
          // twice and, confirmed twice, race for one allocation.
          expect(new Set(ids).size).toBe(ids.length);
        });

        it('reports prices in integer cents, never a float', async () => {
          const page = await connector.enumerateListings!(makeCtx(), {});

          for (const listing of page.listings) {
            if (listing.price === undefined) continue;
            expect(Number.isInteger(listing.price)).toBe(true);
            expect(listing.price).toBeGreaterThanOrEqual(0);
          }
        });

        /**
         * The cursor is opaque to the core, which stores and returns it
         * unchanged. A connector that returns one on its final page sends the
         * core round again forever.
         */
        it('omits the cursor rather than returning an empty one', async () => {
          const page = await connector.enumerateListings!(makeCtx(), {});
          if (page.nextCursor !== undefined) {
            expect(page.nextCursor).not.toBe('');
          }
        });
      });
    }
  });
}
