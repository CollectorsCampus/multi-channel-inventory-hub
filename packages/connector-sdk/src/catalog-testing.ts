import { describe, expect, it } from 'vitest';
import { validateCatalogSource, type CatalogCtx, type CatalogSource } from './catalog';

/**
 * The shared contract suite for catalog sources.
 *
 * Separate from the connector suite and much smaller, which is the whole point
 * of separating the interfaces: a catalog source is asked far less, so it
 * should have far less to satisfy.
 *
 * Run against a recorded or mocked source, never a live public API. These are
 * shared community resources and a test suite hammering them on every CI run
 * is exactly the behaviour that gets projects blocked.
 */
export interface CatalogContractOptions {
  source: CatalogSource;
  makeCtx: () => CatalogCtx;
  /** A query the mock is primed to answer with at least one result. */
  knownQuery: string;
  /** A query the mock answers with nothing. */
  unknownQuery?: string;
}

export function runCatalogSourceContractTests(options: CatalogContractOptions): void {
  const { source, makeCtx } = options;
  const unknown = options.unknownQuery ?? 'zzzz-no-such-product-zzzz';

  describe(`catalog source contract: ${source.key}`, () => {
    it('declares a valid definition', () => {
      expect(validateCatalogSource(source)).toEqual([]);
    });

    it('returns an empty array rather than throwing for a query with no matches', async () => {
      await expect(source.search(makeCtx(), { text: unknown })).resolves.toEqual([]);
    });

    it('returns an empty array for an empty query', async () => {
      // The intake box is empty before the operator types anything.
      await expect(source.search(makeCtx(), { text: '' })).resolves.toEqual([]);
    });

    describe('results', () => {
      it('always carries its own id under its own key', async () => {
        const results = await source.search(makeCtx(), { text: options.knownQuery });
        expect(results.length).toBeGreaterThan(0);

        for (const candidate of results) {
          expect(candidate.sourceId, 'every candidate needs a sourceId').toBeTruthy();
          expect(candidate.name).toBeTruthy();
          // §4 keys the catalog on canonical platform ids, so a source must at
          // minimum identify its own products.
          expect(candidate.externalIds[source.key]).toBe(candidate.sourceId);
        }
      });

      /**
       * Coverage of foreign ids is never complete — Scryfall omits
       * `tcgplayer_id` on roughly a tenth of a modern set and on many older
       * printings (ADR 0002). A source must not fabricate one to look tidy.
       */
      it('omits foreign ids it does not have rather than inventing them', async () => {
        const results = await source.search(makeCtx(), { text: options.knownQuery });
        for (const candidate of results) {
          for (const [namespace, id] of Object.entries(candidate.externalIds)) {
            expect(id, `${namespace} id must not be blank`).toBeTruthy();
            expect(typeof id).toBe('string');
          }
        }
      });

      it('reports prices in integer cents', async () => {
        const results = await source.search(makeCtx(), { text: options.knownQuery });
        for (const candidate of results) {
          if (candidate.marketPrice !== undefined) {
            expect(Number.isInteger(candidate.marketPrice)).toBe(true);
            expect(candidate.marketPrice).toBeGreaterThanOrEqual(0);
          }
        }
      });

      it('honours the requested limit', async () => {
        const results = await source.search(makeCtx(), { text: options.knownQuery, limit: 1 });
        expect(results.length).toBeLessThanOrEqual(1);
      });
    });

    if (typeof source.fetchById === 'function') {
      describe('fetchById', () => {
        it('round-trips an id returned by search', async () => {
          const [first] = await source.search(makeCtx(), { text: options.knownQuery });
          const fetched = await source.fetchById!(makeCtx(), first!.sourceId);
          expect(fetched?.sourceId).toBe(first!.sourceId);
        });

        it('returns null for an unknown id instead of throwing', async () => {
          await expect(source.fetchById!(makeCtx(), 'definitely-not-an-id')).resolves.toBeNull();
        });
      });
    }
  });
}
