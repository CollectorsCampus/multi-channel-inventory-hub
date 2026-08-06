import type {
  CatalogCandidate,
  CatalogCtx,
  CatalogSearchQuery,
  CatalogSetRef,
  CatalogSource,
} from '@hub/connector-sdk';
import { looseIncludes, matchByName } from '@hub/catalog-tcgcsv';
import {
  CARDTRADER_KEY,
  toCandidate,
  toCandidates,
  type CtBlueprint,
  type CtExpansion,
  type CtGame,
} from './blueprints';

/**
 * CardTrader as a `CatalogSource` — read-only, pull side only. There is no
 * `Connector` here yet: `docs/CONNECTOR_ROADMAP.md`'s CardTrader section
 * records three questions still open before selling through it (whether
 * `products/export` alone satisfies `listing.enumerate`, the real order-webhook
 * body shape, and match quality against `CatalogItem`), and none of them is
 * settled by this file.
 *
 * ## Why this exists beside tcgcsv rather than instead of it
 *
 * A CardTrader blueprint publishes its own cross-references —
 * `tcg_player_id`, `scryfall_id`, `card_market_ids` — at 92-100% coverage in
 * every game measured, not Magic-only the way Scryfall's `tcgplayer_id` is.
 * `IntakeService.resolveCatalogItem` matches a candidate's `externalIds`
 * against `CatalogExternalRef` with an `OR` across every namespace it carries,
 * so an item this source proposes converges on one already created by tcgcsv
 * or Scryfall **by design** — not because the two sources happen to agree,
 * which was true before this existed only by luck.
 *
 * ## The same shape as tcgcsv, and for the same reason
 *
 * `/blueprints/export` returns a whole expansion unpaginated and there is no
 * blueprint search endpoint and no `GET /blueprints/:id` — so, exactly like
 * tcgcsv, this is an importer wearing a search interface. `search()` narrows
 * to a small number of expansions and downloads them; an unscoped query throws
 * rather than walking the catalogue.
 *
 * ## What it cannot do, stated first
 *
 * **No price, ever.** `/blueprints/export` carries no price field at all —
 * pricing lives on `/marketplace/products`, a *listing* endpoint keyed on
 * blueprint id, not a catalogue one. Unlike tcgcsv, there is no reference price
 * to report even approximately.
 *
 * **No `printings`.** CardTrader expresses finish as a set of independent
 * per-game booleans (`mtg_foil`, `first_edition`, …) with no shared
 * vocabulary to normalise into tcgcsv's `NORMAL`/`FOIL`-style enum. Guessing
 * one would invent data this source does not have.
 *
 * See `blueprints.ts` for the field-level mapping and what was actually
 * measured against the live API on 2026-08-03/04.
 */

export const CARDTRADER_SOURCE_KEY = CARDTRADER_KEY;

const DEFAULT_BASE_URL = 'https://api.cardtrader.com/api/v2';

/**
 * CardTrader publishes no rate limit in its documentation or its response
 * headers (checked 2026-08-04: no `X-RateLimit-*` on a live `/games` call).
 * Chosen conservatively, matching tcgcsv's own courtesy default rather than
 * a measured ceiling — nothing here is urgent enough to push harder.
 */
const DEFAULT_REQUESTS_PER_SECOND = 4;

/** How many expansions one search may download. Each is a separate request. */
const DEFAULT_MAX_EXPANSIONS_PER_SEARCH = 4;

/**
 * How many games one search may span before it is refused. Two, not one, for
 * the same reason tcgcsv allows two categories: a name that legitimately
 * matches a pair should not be forced to disambiguate a search that would
 * have worked anyway.
 */
const DEFAULT_MAX_GAMES_PER_SEARCH = 2;

/**
 * `/games` and `/expansions` change on the order of "CardTrader added a
 * product line", not per session — an hour is generous rather than load-bearing.
 */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CardTraderSourceOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
  /** Injected for tests, so cache expiry is assertable without waiting. */
  now?: () => number;
  cacheTtlMs?: number;
  maxExpansionsPerSearch?: number;
  maxGamesPerSearch?: number;
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export function createCardTraderSource(options: CardTraderSourceOptions = {}): CatalogSource {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxExpansions = options.maxExpansionsPerSearch ?? DEFAULT_MAX_EXPANSIONS_PER_SEARCH;
  const maxGames = options.maxGamesPerSearch ?? DEFAULT_MAX_GAMES_PER_SEARCH;

  const jsonCache = new Map<string, CacheEntry<unknown>>();

  /**
   * Blueprint id -> expansion id, the same role tcgcsv's `productIndex` plays.
   * CardTrader publishes no blueprint-to-expansion index either, so
   * `fetchById` can only resolve a blueprint from an expansion already read.
   */
  const blueprintIndex = new Map<string, number>();

  function authHeaders(ctx: CatalogCtx): Record<string, string> {
    const token = ctx.secrets.token;
    if (!token) {
      throw new Error(
        'CardTrader requires a token. Configure credentials for the "cardtrader" catalog ' +
          'source (Settings, or PUT /catalog/sources/cardtrader/credentials) before searching.',
      );
    }
    return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  }

  async function fetchJson<T>(ctx: CatalogCtx, path: string): Promise<T> {
    const url = `${baseUrl}${path}`;

    const cached = jsonCache.get(url);
    if (cached && now() - cached.storedAt < cacheTtlMs) return cached.value as T;

    const response = await doFetch(url, { headers: authHeaders(ctx), signal: ctx.signal });
    if (!response.ok) {
      throw new Error(`CardTrader responded ${response.status} for ${path}`);
    }

    const body = (await response.json()) as T;
    jsonCache.set(url, { value: body, storedAt: now() });
    return body;
  }

  // `/games` wraps its array in `{ array: [...] }`; `/expansions` and
  // `/blueprints/export` are bare arrays. Measured, not assumed — the two
  // shapes are handled explicitly here rather than by a generic "unwrap if
  // wrapped" helper, so a real shape change fails loudly instead of silently
  // finding nothing.
  async function games(ctx: CatalogCtx): Promise<CtGame[]> {
    const body = await fetchJson<{ array: CtGame[] }>(ctx, '/games');
    return body.array;
  }

  async function expansions(ctx: CatalogCtx): Promise<CtExpansion[]> {
    return fetchJson<CtExpansion[]>(ctx, '/expansions');
  }

  function matchGames(all: readonly CtGame[], game: string): CtGame[] {
    return matchByName(all, game, (g) => [g.name, g.display_name]);
  }

  async function fetchExpansionBlueprints(
    ctx: CatalogCtx,
    expansionId: number,
  ): Promise<CtBlueprint[]> {
    const blueprints = await fetchJson<CtBlueprint[]>(
      ctx,
      `/blueprints/export?expansion_id=${expansionId}`,
    );
    // Index the whole expansion, not only what a search matched — the caller
    // confirms one blueprint out of an expansion it searched, and which one
    // is not knowable here. Mirrors tcgcsv's `search`/`fetchSet`.
    for (const blueprint of blueprints) blueprintIndex.set(String(blueprint.id), expansionId);
    return blueprints;
  }

  return {
    key: CARDTRADER_KEY,
    displayName: 'CardTrader',
    description:
      "CardTrader's product catalogue across 14 games, via the operator's own API token. " +
      'Blueprints carry TCGPlayer, Scryfall and Cardmarket ids, so items converge on the ' +
      'existing local catalog rather than duplicating it. No price at the catalogue level. ' +
      'Requires a set name to search.',

    // Resolved live from /games rather than compiled in, the same reason
    // tcgcsv declares none: CardTrader can add a product line without this
    // package changing.
    games: [],

    providesExternalIds: ['tcgplayer', 'scryfall', 'cardmarket'],
    secretFields: ['token'],
    rateLimit: { requestsPerSecond: DEFAULT_REQUESTS_PER_SECOND },

    async search(ctx: CatalogCtx, query: CatalogSearchQuery): Promise<CatalogCandidate[]> {
      const text = query.text.trim();
      if (text === '') return [];

      const allGames = await games(ctx);
      const inScope = query.game ? matchGames(allGames, query.game) : allGames;

      if (inScope.length === 0) {
        ctx.logger.debug(`CardTrader has no game matching "${query.game ?? ''}"`);
        return [];
      }

      if (inScope.length > maxGames) {
        throw new Error(
          `CardTrader needs a game to search: finding a set otherwise means scanning every ` +
            `expansion of ${inScope.length} games (limit ${maxGames}). Pass a game such as ` +
            `"Pokémon" or "Magic".`,
        );
      }

      const allExpansions = await expansions(ctx);
      const gameIds = new Set(inScope.map((g) => g.id));
      const inGame = allExpansions.filter((e) => gameIds.has(e.game_id));

      const wantedSet = query.setName;
      const candidateExpansions =
        wantedSet === undefined ? inGame : matchByName(inGame, wantedSet, (e) => [e.name]);

      if (candidateExpansions.length === 0) return [];

      if (candidateExpansions.length > maxExpansions) {
        throw new Error(
          `CardTrader matched ${candidateExpansions.length} sets for ` +
            `"${query.setName ?? query.game ?? ''}", above the limit of ${maxExpansions}. Each ` +
            `set is a separate download, so name the set more precisely.`,
        );
      }

      const gameById = new Map(allGames.map((g) => [g.id, g.name]));
      const expansionById = new Map(allExpansions.map((e) => [e.id, e.name]));

      const matched: CatalogCandidate[] = [];
      for (const expansion of candidateExpansions) {
        const blueprints = await fetchExpansionBlueprints(ctx, expansion.id);

        const rows = blueprints.filter(
          (b) =>
            looseIncludes(b.name, text) || (b.version ? looseIncludes(b.version, text) : false),
        );

        matched.push(
          ...toCandidates(rows, {
            gameName: (id) => gameById.get(id),
            expansionName: (id) => expansionById.get(id),
          }),
        );
      }

      return query.limit ? matched.slice(0, query.limit) : matched;
    },

    /**
     * Every expansion this source can enumerate, optionally narrowed to one
     * game. Unlike tcgcsv, this costs exactly two requests (`/games` plus
     * `/expansions`) no matter how much of the catalogue is asked for —
     * `/expansions` returns every game's sets in one response, so there is no
     * per-category fan-out to guard against and this is never capped.
     */
    async listSets(ctx: CatalogCtx, game?: string): Promise<CatalogSetRef[]> {
      const allGames = await games(ctx);
      const inScope = game ? matchGames(allGames, game) : allGames;
      const gameIds = new Set(inScope.map((g) => g.id));
      const gameById = new Map(allGames.map((g) => [g.id, g.name]));

      const allExpansions = await expansions(ctx);

      return allExpansions
        .filter((e) => gameIds.has(e.game_id))
        .map((e) => ({
          setId: String(e.id),
          name: e.name,
          game: gameById.get(e.game_id) ?? '',
          // No `releasedAt`: `/expansions` publishes no date.
        }));
    },

    /** Every blueprint in one expansion. Also populates `blueprintIndex` — see there. */
    async fetchSet(ctx: CatalogCtx, setId: string): Promise<CatalogCandidate[]> {
      const expansionId = Number(setId);
      if (!Number.isInteger(expansionId)) {
        throw new Error(`CardTrader set id "${setId}" must be a numeric expansion id.`);
      }

      const [allGames, allExpansions] = await Promise.all([games(ctx), expansions(ctx)]);
      const expansion = allExpansions.find((e) => e.id === expansionId);
      const gameName = expansion
        ? allGames.find((g) => g.id === expansion.game_id)?.name
        : undefined;

      const blueprints = await fetchExpansionBlueprints(ctx, expansionId);

      return toCandidates(blueprints, {
        gameName: () => gameName,
        expansionName: () => expansion?.name,
      });
    },

    /**
     * Re-fetch one blueprint by its id, from an expansion already downloaded.
     *
     * CardTrader publishes no blueprint-to-expansion index and no per-id
     * endpoint, so an id alone cannot be located — the same constraint tcgcsv
     * documents on its own `fetchById`. Returns null for anything unseen
     * rather than scanning every expansion of every game.
     */
    async fetchById(ctx: CatalogCtx, sourceId: string): Promise<CatalogCandidate | null> {
      const blueprintId = sourceId.trim();
      if (blueprintId === '') return null;

      const expansionId = blueprintIndex.get(blueprintId);
      if (expansionId === undefined) {
        ctx.logger.debug(
          `CardTrader cannot re-fetch blueprint ${blueprintId}: no expansion containing it has ` +
            `been read. Search its set first.`,
        );
        return null;
      }

      const [allGames, allExpansions] = await Promise.all([games(ctx), expansions(ctx)]);
      const expansion = allExpansions.find((e) => e.id === expansionId);
      const gameName = expansion
        ? allGames.find((g) => g.id === expansion.game_id)?.name
        : undefined;

      const blueprints = await fetchExpansionBlueprints(ctx, expansionId);
      const found = blueprints.find((b) => String(b.id) === blueprintId);
      if (!found) return null;

      return toCandidate(found, { gameName: () => gameName, expansionName: () => expansion?.name });
    },
  };
}
