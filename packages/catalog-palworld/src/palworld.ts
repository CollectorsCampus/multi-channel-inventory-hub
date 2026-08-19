import type {
  CatalogCandidate,
  CatalogCtx,
  CatalogSearchQuery,
  CatalogSetRef,
  CatalogSource,
} from '@hub/connector-sdk';
import {
  PALWORLD_GAME,
  PALWORLD_KEY,
  flattenProducts,
  toCandidate,
  toCandidates,
  type PwCard,
  type PwListResponse,
  type PwProductsResponse,
} from './cards';

/**
 * Bushiroad's own Palworld card database as a `CatalogSource`.
 *
 * It exists because **no marketplace catalogue carries Palworld yet**: the game
 * launched 2026-07-30, TCGPlayer has opened no category for it, so tcgcsv — a
 * mirror of TCGPlayer — has nothing to republish, and CardTrader's games do not
 * include it either (all three checked live, 2026-08-17). Without this, a
 * Palworld card could still be stocked and listed under a `hub:` code, but with
 * no search at intake, no image and no set name.
 *
 * ## What it cannot do, stated first
 *
 * **No prices.** A publisher's card database has no market, so Palworld singles
 * cannot be repriced by any source this hub has. That does not change until a
 * marketplace catalogue carries the game.
 *
 * **No cross-references.** Bushiroad has no reason to publish a TCGPlayer id,
 * so a card ingested here carries only a `palworld` ref.
 * `IntakeService.resolveCatalogItem` matches on external refs alone, so when
 * TCGPlayer eventually opens the category, a tcgcsv ingest will create a
 * *second* catalog item for the same card rather than converging on this one —
 * unlike CardTrader, which converges precisely because it publishes
 * `tcg_player_id`. Both sides publish the collector number, so a one-off
 * reconciliation is possible when that day comes, but nothing does it today.
 * **That is the argument for using this at intake and not bulk-ingesting the
 * whole set**: only cards actually stocked acquire a `palworld` ref, so only
 * those need reconciling later.
 *
 * ## Why it is simpler than tcgcsv and CardTrader
 *
 * Those two are importers wearing a search interface — a whole set file per
 * request, an unscoped search refused rather than served, and a `fetchById`
 * that goes blind after a restart because neither publishes a product-to-set
 * index. None of that applies here. The entire English catalogue is 256 cards
 * across three products, so this reads all of it once, caches it, and answers
 * search, `fetchById` and `fetchSet` from memory. An unscoped search is a
 * legitimate question when the answer is a few hundred rows, and `fetchById`
 * works from cold because the cache is the whole catalogue rather than
 * whichever sets someone happened to browse.
 *
 * The cap below is what keeps that true as sets are released.
 *
 * ## The risk worth knowing
 *
 * This is an **undocumented endpoint** — a WordPress plugin route
 * (`bushiroad-card-manager`) discovered from the site's own JavaScript, not a
 * published API. It is first-party and unauthenticated, and it did not gate on
 * User-Agent when checked, but it can change without notice. Same risk class as
 * tcgcsv's community CDN, with the difference that tcgcsv at least intends to
 * be consumed.
 */

export const PALWORLD_SOURCE_KEY = PALWORLD_KEY;

const DEFAULT_BASE_URL = 'https://en.palworld-official-cardgame.com/manage';

const DEFAULT_IMAGE_BASE =
  'https://en.palworld-official-cardgame.com/wordpress/wp-content/images/cardlist';

/**
 * No published rate limit and no `X-RateLimit-*` headers, so this is a courtesy
 * ceiling rather than a measured one — the same choice `catalog-cardtrader`
 * made, and this reads the catalogue about once an hour at most.
 */
const DEFAULT_REQUESTS_PER_SECOND = 4;

/** Rows per request. The API accepts a page size; 100 keeps it to three calls. */
const PAGE_SIZE = 100;

/**
 * A ceiling on how much of the catalogue one refresh will read.
 *
 * The whole-catalogue cache is only honest while the catalogue is small. At 100
 * rows a page this is 20 requests — years of releases at Bushiroad's pace — and
 * hitting it means the design should be revisited rather than silently reading
 * a fraction, so it **throws** rather than truncating.
 */
const MAX_PAGES = 20;

/**
 * The catalogue changes when a set releases, not per session. An hour is
 * generous rather than load-bearing, matching the other sources.
 */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PalworldSourceOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
  imageBase?: string;
  /** Injected for tests, so cache expiry is assertable without waiting. */
  now?: () => number;
  cacheTtlMs?: number;
}

export function createPalworldSource(options: PalworldSourceOptions = {}): CatalogSource {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const imageBase = options.imageBase ?? DEFAULT_IMAGE_BASE;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  let cachedCards: { value: PwCard[]; storedAt: number } | undefined;
  let cachedProducts: { value: CatalogSetRef[]; storedAt: number } | undefined;

  async function fetchJson<T>(ctx: CatalogCtx, path: string): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      // An explicit User-Agent on every HTTP client in this repo, per the
      // tcgcsv lesson: Node's fetch sends none, and a CDN that 401s a blank one
      // fails only in production, where no test ever exercises a header. This
      // endpoint did not gate on it when checked — the point is not to find out
      // the hard way if that changes.
      headers: { Accept: 'application/json', 'User-Agent': 'multi-channel-inventory-hub' },
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new Error(`Palworld card database responded ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }

  /** The whole English catalogue, read once and reused. */
  async function allCards(ctx: CatalogCtx): Promise<PwCard[]> {
    if (cachedCards && now() - cachedCards.storedAt < cacheTtlMs) return cachedCards.value;

    const cards: PwCard[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await fetchJson<PwListResponse>(
        ctx,
        `/card-list-user/list?page=${page}&per_page=${PAGE_SIZE}`,
      );
      const items = body.items ?? [];
      cards.push(...items);

      const total = body.total;
      if (items.length < PAGE_SIZE) break;
      if (typeof total === 'number' && cards.length >= total) break;

      if (page === MAX_PAGES) {
        throw new Error(
          `Palworld card database has more than ${MAX_PAGES * PAGE_SIZE} cards; this source ` +
            'reads the whole catalogue into memory and needs revisiting before it can serve ' +
            'one that large.',
        );
      }
    }

    cachedCards = { value: cards, storedAt: now() };
    return cards;
  }

  return {
    key: PALWORLD_KEY,
    displayName: 'Palworld OFFICIAL CARD GAME',
    description:
      "Bushiroad's own card database. Names, sets, collector numbers and images — no prices, " +
      'because a publisher database has no market.',
    games: [PALWORLD_GAME],
    providesExternalIds: [PALWORLD_KEY],
    rateLimit: {
      requestsPerSecond: DEFAULT_REQUESTS_PER_SECOND,
      burst: DEFAULT_REQUESTS_PER_SECOND,
    },

    /**
     * Free-text over the whole catalogue.
     *
     * Unscoped is fine here, unlike tcgcsv and CardTrader: the catalogue is a
     * few hundred rows and already in memory, so there is no request to save by
     * refusing. A game filter naming something else answers nothing rather than
     * everything — the caller asked about a game this source does not have.
     */
    async search(ctx: CatalogCtx, query: CatalogSearchQuery): Promise<CatalogCandidate[]> {
      if (query.game && query.game.trim().toLowerCase() !== PALWORLD_GAME.toLowerCase()) {
        return [];
      }

      const cards = await allCards(ctx);
      const needle = (query.text ?? '').trim().toLowerCase();
      const set = (query.setName ?? '').trim().toLowerCase();

      const matched = cards.filter((card) => {
        if (set) {
          // The code (`EBP01`) or the printed name, since a caller may hold
          // either — `listSets` hands back the code, a human types the name.
          const inSet =
            (card.expansion ?? '').toLowerCase() === set ||
            (card.expansion_name ?? '').toLowerCase().includes(set);
          if (!inSet) return false;
        }
        if (!needle) return true;
        // The collector number is searchable too, since it is how a seller
        // reading a card in hand identifies it.
        return (
          (card.card_name ?? '').toLowerCase().includes(needle) ||
          (card.card_number ?? '').toLowerCase().includes(needle)
        );
      });

      const candidates = toCandidates(matched, imageBase);
      return query.limit && query.limit > 0 ? candidates.slice(0, query.limit) : candidates;
    },

    /**
     * One card by its database id.
     *
     * Works from cold, unlike tcgcsv's and CardTrader's, because the cache is
     * the whole catalogue rather than whichever sets were browsed — the failure
     * that broke a live SKU write mid-run and is recorded in CLAUDE.md.
     */
    async fetchById(ctx: CatalogCtx, id: string): Promise<CatalogCandidate | null> {
      const cards = await allCards(ctx);
      const card = cards.find((c) => String(c.id) === id);
      return card ? toCandidate(card, imageBase) : null;
    },

    async listSets(ctx: CatalogCtx, game?: string): Promise<CatalogSetRef[]> {
      if (game && game.trim().toLowerCase() !== PALWORLD_GAME.toLowerCase()) return [];

      if (cachedProducts && now() - cachedProducts.storedAt < cacheTtlMs) {
        return cachedProducts.value;
      }

      const body = await fetchJson<PwProductsResponse>(ctx, '/card-list-user/products');
      const sets = flattenProducts(body).flatMap((product) => {
        const setId = (product.code ?? '').trim();
        const name = (product.name ?? '').trim();
        // Keyed on the code, which is what a card's `expansion` carries — a
        // product with neither cannot be fetched, so it is not offered.
        return setId && name ? [{ setId, name, game: PALWORLD_GAME }] : [];
      });

      cachedProducts = { value: sets, storedAt: now() };
      return sets;
    },

    async fetchSet(ctx: CatalogCtx, setId: string): Promise<CatalogCandidate[]> {
      const cards = await allCards(ctx);
      const wanted = setId.trim().toLowerCase();
      return toCandidates(
        cards.filter((card) => (card.expansion ?? '').toLowerCase() === wanted),
        imageBase,
      );
    },
  };
}
