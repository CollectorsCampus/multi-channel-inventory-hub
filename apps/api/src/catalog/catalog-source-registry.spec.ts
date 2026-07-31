import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogCandidate, CatalogCtx, CatalogSource } from '@hub/connector-sdk';
import { CatalogSourceRegistry } from './catalog-source-registry.service';

const ctx = (): CatalogCtx => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  secrets: {},
});

function candidate(
  key: string,
  id: string,
  extra: Partial<CatalogCandidate> = {},
): CatalogCandidate {
  return { sourceId: id, name: id, externalIds: { [key]: id }, ...extra };
}

function source(overrides: Partial<CatalogSource> = {}): CatalogSource {
  const key = overrides.key ?? 'scryfall';
  return {
    key,
    displayName: 'Test Source',
    games: [],
    search: async () => [candidate(key, 'a')],
    ...overrides,
  };
}

describe('CatalogSourceRegistry', () => {
  let registry: CatalogSourceRegistry;

  beforeEach(() => {
    registry = new CatalogSourceRegistry();
  });

  it('registers and resolves by key', () => {
    const s = source();
    registry.register(s);
    expect(registry.get('scryfall')).toBe(s);
    expect(registry.has('scryfall')).toBe(true);
  });

  it('rejects a key that would be unsafe as CatalogExternalRef.source', () => {
    expect(() => registry.register(source({ key: 'Scryfall API!' }))).toThrow(/lowercase/);
  });

  it('rejects a source with no search implementation', () => {
    expect(() =>
      registry.register(source({ search: undefined as unknown as CatalogSource['search'] })),
    ).toThrow(/must implement `search\(\)`/);
  });

  it('refuses two sources claiming the same key', () => {
    registry.register(source());
    expect(() => registry.register(source())).toThrow(/both claim the key/);
  });

  describe('routing', () => {
    beforeEach(() => {
      registry.register(source({ key: 'scryfall', games: ['Magic'] }));
      registry.register(source({ key: 'pokemontcg', games: ['Pokemon'] }));
      registry.register(source({ key: 'manual', games: [] }));
    });

    it('routes a game to the sources that cover it', () => {
      expect(registry.sourcesForGame('Magic').map((s) => s.key)).toEqual(['scryfall', 'manual']);
      expect(registry.sourcesForGame('Pokemon').map((s) => s.key)).toEqual([
        'pokemontcg',
        'manual',
      ]);
    });

    it('treats an empty games list as "covers everything"', () => {
      // Otherwise every single-game source would have to enumerate what it is not.
      expect(registry.sourcesForGame('Yu-Gi-Oh').map((s) => s.key)).toEqual(['manual']);
    });

    it('consults every source when no game is given', () => {
      expect(registry.sourcesForGame().map((s) => s.key)).toEqual([
        'scryfall',
        'pokemontcg',
        'manual',
      ]);
    });
  });

  /**
   * The ingest UI defaults to an ingestable source, so the summary must say
   * which ones are — a source with half the pair is rejected at registration,
   * so this is a plain both-or-neither fact.
   */
  it('reports which sources can fill the local catalog', () => {
    registry.register(source({ key: 'bulk', listSets: async () => [], fetchSet: async () => [] }));
    registry.register(source({ key: 'searchonly' }));

    const byKey = new Map(registry.list().map((s) => [s.key, s.canIngest]));
    expect(byKey.get('bulk')).toBe(true);
    expect(byKey.get('searchonly')).toBe(false);
  });

  it('finds sources that can supply a given id namespace', () => {
    registry.register(source({ key: 'scryfall', providesExternalIds: ['tcgplayer'] }));
    registry.register(source({ key: 'other' }));

    expect(registry.sourcesProviding('tcgplayer').map((s) => s.key)).toEqual(['scryfall']);
    // A source always provides its own namespace.
    expect(registry.sourcesProviding('other').map((s) => s.key)).toEqual(['other']);
  });

  describe('fan-out search', () => {
    it('merges results and attributes each to its source', async () => {
      registry.register(
        source({ key: 'scryfall', search: async () => [candidate('scryfall', 'x')] }),
      );
      registry.register(source({ key: 'other', search: async () => [candidate('other', 'y')] }));

      const { candidates, failures } = await registry.search(ctx, { text: 'bolt' });

      expect(failures).toEqual([]);
      expect(candidates.map((c) => [c.sourceKey, c.sourceId])).toEqual([
        ['scryfall', 'x'],
        ['other', 'y'],
      ]);
    });

    /**
     * Catalog sources are third-party services outside our control. An operator
     * mid-intake should still see results from whichever sources answered.
     */
    it('survives one source failing and reports which', async () => {
      registry.register(
        source({
          key: 'flaky',
          search: async () => {
            throw new Error('502 Bad Gateway');
          },
        }),
      );
      registry.register(
        source({ key: 'healthy', search: async () => [candidate('healthy', 'z')] }),
      );

      const { candidates, failures } = await registry.search(ctx, { text: 'bolt' });

      expect(candidates.map((c) => c.sourceId)).toEqual(['z']);
      expect(failures).toEqual([{ sourceKey: 'flaky', message: '502 Bad Gateway' }]);
    });

    it('only queries sources matching the requested game', async () => {
      const magic = vi.fn().mockResolvedValue([]);
      const pokemon = vi.fn().mockResolvedValue([]);
      registry.register(source({ key: 'scryfall', games: ['Magic'], search: magic }));
      registry.register(source({ key: 'pokemontcg', games: ['Pokemon'], search: pokemon }));

      await registry.search(ctx, { text: 'charizard', game: 'Pokemon' });

      expect(magic).not.toHaveBeenCalled();
      expect(pokemon).toHaveBeenCalledOnce();
    });

    it('returns nothing rather than failing when no source covers the game', async () => {
      registry.register(source({ key: 'scryfall', games: ['Magic'] }));
      await expect(registry.search(ctx, { text: 'x', game: 'Flesh and Blood' })).resolves.toEqual({
        candidates: [],
        failures: [],
      });
    });
  });
});
