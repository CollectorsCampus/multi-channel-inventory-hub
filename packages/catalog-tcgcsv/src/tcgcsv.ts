import type {
  CatalogCandidate,
  CatalogCtx,
  CatalogSearchQuery,
  CatalogSource,
} from '@hub/connector-sdk';
import {
  TCGCSV_KEY,
  looseIncludes,
  matchByName,
  parseCategories,
  parseGroups,
  parseProductsAndPrices,
  toCandidates,
  type TcgcsvCategory,
  type TcgcsvGroup,
} from './rows';

/**
 * tcgcsv.com as a `CatalogSource` — TCGPlayer's product catalogue and reference
 * prices, for the 90 categories it publishes.
 *
 * This exists because Scryfall covers Magic and nothing else, while a real
 * TCGPlayer inventory spans far more: One Piece, Lorcana, Flesh & Blood, Union
 * Arena, Gundam, sleeves, deck boxes and playmats all appear in the operator's
 * own exports and none of them has a catalog source today.
 *
 * ## What it cannot do, stated first
 *
 * **There are no per-condition prices, and there never will be.** tcgcsv says so
 * itself: it does not publish the SKU tier, where a SKU is "a combination of a
 * Product, Language, Printing, and Condition" — which is exactly `Sku`'s natural
 * key here. Prices arrive per `productId` + printing, so a Near Mint and a
 * Damaged copy of the same card share one number.
 *
 * The consequence worth being explicit about: these prices **cannot be keyed to
 * a TCGPlayer listing.** An allocation's `externalListingId` is the SKU-level
 * `TCGplayer Id`, a different id space from the product-level `productId` here.
 * This is a catalogue and a market reference, not a price feed for listings.
 *
 * ## It is really an importer wearing a search interface
 *
 * tcgcsv is a set of static files on a CDN. There is no search endpoint, so
 * `search()` cannot be a single query — it has to fetch and filter whole set
 * files. That works well when the caller narrows to a set and badly otherwise:
 * Magic alone has 453 groups.
 *
 * So an un-narrowed search **throws** rather than either hammering the CDN or
 * quietly returning a fraction of the matches. The registry catches per-source
 * failures and carries on with the others, so the operator sees a warning naming
 * what to add. A source that silently returned partial results would be worse,
 * because a missing card looks identical to a card that does not exist.
 *
 * The honest production shape is a scheduled bulk ingest into `CatalogItem` and
 * `CatalogExternalRef`, with search served from the database. That needs ingest
 * machinery the core does not have yet, which is why this is a prototype.
 */

export const TCGCSV_SOURCE_KEY = TCGCSV_KEY;

const DEFAULT_BASE_URL = 'https://tcgcsv.com/tcgplayer';

/**
 * A community-run mirror with a Patreon, served from CloudFront. Being polite is
 * the point rather than a rate limit we were given: nothing here is urgent, and
 * the whole service exists because TCGPlayer's own programme is closed to new
 * applicants (ADR 0002).
 */
const DEFAULT_REQUESTS_PER_SECOND = 4;

/**
 * How many set files one search may download.
 *
 * Low on purpose. Four is enough for "this set, and a couple of near-name
 * matches"; it is not enough to walk a category, which is the request that should
 * fail loudly instead.
 */
const DEFAULT_MAX_GROUPS_PER_SEARCH = 4;

/**
 * Content changes once a day, around 20:00 UTC. An hour is short enough that a
 * long-running instance picks up a new drop the same evening, and long enough
 * that a burst of intake searches does not re-download the same set file.
 */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TcgcsvSourceOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
  /** Injected for tests, so cache expiry is assertable without waiting. */
  now?: () => number;
  cacheTtlMs?: number;
  maxGroupsPerSearch?: number;
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export function createTcgcsvSource(options: TcgcsvSourceOptions = {}): CatalogSource {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxGroups = options.maxGroupsPerSearch ?? DEFAULT_MAX_GROUPS_PER_SEARCH;

  const textCache = new Map<string, CacheEntry<string>>();

  /**
   * Where each product last seen was found.
   *
   * The only product-to-set index that can exist here, because tcgcsv publishes
   * none. Populated as sets are read, which is what makes `fetchById` work for
   * the search-then-confirm flow and honestly fail for anything else.
   *
   * Holds paths and names, not rows: the rows are already in `textCache` and
   * duplicating them would double the memory for no gain.
   */
  const productIndex = new Map<
    string,
    { path: string; categoryName?: string; groupName?: string }
  >();

  async function fetchText(ctx: CatalogCtx, path: string): Promise<string> {
    const url = `${baseUrl}${path}`;

    const cached = textCache.get(url);
    if (cached && now() - cached.storedAt < cacheTtlMs) return cached.value;

    const response = await doFetch(url, { signal: ctx.signal });
    if (!response.ok) {
      throw new Error(`tcgcsv responded ${response.status} for ${path}`);
    }

    const body = await response.text();
    textCache.set(url, { value: body, storedAt: now() });
    return body;
  }

  async function categories(ctx: CatalogCtx): Promise<TcgcsvCategory[]> {
    return parseCategories(await fetchText(ctx, '/Categories.csv'));
  }

  async function groups(ctx: CatalogCtx, categoryId: string): Promise<TcgcsvGroup[]> {
    return parseGroups(await fetchText(ctx, `/${categoryId}/Groups.csv`));
  }

  /**
   * Match a `game` against a category.
   *
   * Both names are offered because callers legitimately hold either: our
   * `CatalogItem.game` stores the short form ("Magic"), while a human-facing
   * filter may carry the long one ("Magic: The Gathering").
   */
  function matchCategories(all: readonly TcgcsvCategory[], game: string): TcgcsvCategory[] {
    return matchByName(all, game, (c) => [c.name, c.displayName]);
  }

  return {
    key: TCGCSV_KEY,
    displayName: 'tcgcsv (TCGPlayer catalogue)',
    description:
      'TCGPlayer product catalogue and reference prices for 90 categories, via tcgcsv.com. ' +
      'Prices are per product and printing — never per condition. Requires a set name to search.',

    // Empty means "always consulted": tcgcsv publishes 90 categories and the
    // list is fetched, not compiled in, so enumerating games here would go stale
    // every time TCGPlayer adds a product line.
    games: [],

    // The reason this source is worth having: it supplies the product-level
    // `tcgplayer` id that `CatalogExternalRef` is keyed on, for everything
    // Scryfall cannot see.
    providesExternalIds: ['tcgplayer'],

    rateLimit: { requestsPerSecond: DEFAULT_REQUESTS_PER_SECOND },

    async search(ctx: CatalogCtx, query: CatalogSearchQuery): Promise<CatalogCandidate[]> {
      const text = query.text.trim();
      if (text === '') return [];

      const allCategories = await categories(ctx);
      const inScope = query.game ? matchCategories(allCategories, query.game) : allCategories;

      if (inScope.length === 0) {
        // A game we have no category for is "nothing here", not a failure —
        // the registry asks every source and most will not cover a given game.
        ctx.logger.debug(`tcgcsv has no category matching game "${query.game ?? ''}"`);
        return [];
      }

      // Resolving groups costs one request per category, so an un-narrowed
      // search over 90 categories is refused before it starts.
      if (!query.setName && inScope.length > 1) {
        throw new Error(
          `tcgcsv needs a set name, or a game, to search: it has no search endpoint and must ` +
            `download whole set files. Narrow the query (${inScope.length} categories in scope).`,
        );
      }

      const wantedSet = query.setName;
      const candidateGroups: TcgcsvGroup[] = [];
      for (const category of inScope) {
        const all = await groups(ctx, category.categoryId);
        candidateGroups.push(
          ...(wantedSet === undefined ? all : matchByName(all, wantedSet, (g) => [g.name])),
        );
      }

      if (candidateGroups.length === 0) return [];

      if (candidateGroups.length > maxGroups) {
        throw new Error(
          `tcgcsv matched ${candidateGroups.length} sets for "${query.setName ?? query.game ?? ''}", ` +
            `above the limit of ${maxGroups}. Each set is a separate download, so name the set ` +
            `more precisely rather than having this walk the catalogue.`,
        );
      }

      const categoryById = new Map(allCategories.map((c) => [c.categoryId, c.name]));
      const groupById = new Map(candidateGroups.map((g) => [g.groupId, g.name]));

      const matched: CatalogCandidate[] = [];
      for (const group of candidateGroups) {
        const path = `/${group.categoryId}/${group.groupId}/ProductsAndPrices.csv`;
        const all = parseProductsAndPrices(await fetchText(ctx, path));

        // Index the whole set, not only the rows that matched the query. The
        // caller confirms one product out of a set it searched, and which one it
        // picks is not knowable here.
        for (const row of all) {
          productIndex.set(row.productId, {
            path,
            ...(categoryById.get(row.categoryId) !== undefined
              ? { categoryName: categoryById.get(row.categoryId) }
              : {}),
            ...(groupById.get(row.groupId) !== undefined
              ? { groupName: groupById.get(row.groupId) }
              : {}),
          });
        }

        const rows = all.filter((row) => looseIncludes(row.name, text));

        matched.push(
          ...toCandidates(rows, {
            categoryName: (id) => categoryById.get(id),
            groupName: (id) => groupById.get(id),
          }),
        );
      }

      return query.limit ? matched.slice(0, query.limit) : matched;
    },

    /**
     * Re-fetch one product by its `productId`, from a set already downloaded.
     *
     * tcgcsv publishes no product-to-set index, so an id alone cannot be located
     * — there is nowhere to look it up. What *is* available is the sets this
     * source has already read, and that covers the case that matters: the core
     * re-verifies a candidate it just searched for, and refuses to trust a
     * client-supplied name or external id when writing `CatalogExternalRef`
     * (see `IntakeDto`). Searching a set then confirming from it is exactly the
     * flow, and the set is in the cache by then.
     *
     * Returns null for anything unseen rather than guessing or scanning ~4,000
     * set files. `CatalogService.fetchCandidate` already treats null as "cannot
     * re-verify" and the caller reports it, so the failure is explicit.
     */
    async fetchById(ctx: CatalogCtx, sourceId: string): Promise<CatalogCandidate | null> {
      const productId = sourceId.trim();
      if (productId === '') return null;

      const known = productIndex.get(productId);
      if (!known) {
        ctx.logger.debug(
          `tcgcsv cannot re-fetch product ${productId}: no set containing it has been read. ` +
            `Search its set first.`,
        );
        return null;
      }

      const rows = parseProductsAndPrices(await fetchText(ctx, known.path)).filter(
        (row) => row.productId === productId,
      );
      if (rows.length === 0) return null;

      const [candidate] = toCandidates(rows, {
        categoryName: () => known.categoryName,
        groupName: () => known.groupName,
      });

      return candidate ?? null;
    },
  };
}
