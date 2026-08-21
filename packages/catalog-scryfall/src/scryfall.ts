import type {
  CatalogCandidate,
  CatalogCtx,
  CatalogSearchQuery,
  CatalogSource,
} from '@hub/connector-sdk';
import { usdStringToCents } from './money';

/**
 * Scryfall as a catalog source — Magic: The Gathering only.
 *
 * Free, documented, needs no key, and its card objects carry `tcgplayer_id`,
 * which is how §4's "reuse canonical platform IDs" survives TCGPlayer's API
 * closure (ADR 0002).
 *
 * Coverage of that id is **not** universal. Measured against the live API:
 * present on modern printings, absent on roughly a tenth of one modern set and
 * missing entirely from the Black Lotus printing returned by `/cards/named`.
 * This source therefore omits the key when Scryfall has no id, rather than
 * writing a blank that would never match anything.
 */

export const SCRYFALL_KEY = 'scryfall';
const DEFAULT_BASE_URL = 'https://api.scryfall.com';

/**
 * Scryfall asks API consumers to identify themselves and to stay around
 * 10 requests/second. Both are courtesy obligations to a free community
 * service, not merely safety limits.
 *
 * The default names this project so a misbehaving deployment can be traced back
 * to software rather than to an anonymous IP — self-hosters all share this
 * identity. Override it if you would rather your instance be anonymous.
 */
const DEFAULT_USER_AGENT =
  'InventoryHub/0.1 (+https://github.com/CollectorsCampus/multi-channel-inventory-hub)';

/** Only the fields we consume. Scryfall returns far more. */
interface ScryfallCard {
  id: string;
  name: string;
  set_name?: string;
  collector_number?: string;
  lang?: string;
  tcgplayer_id?: number;
  cardmarket_id?: number;
  finishes?: string[];
  image_uris?: { large?: string; normal?: string; small?: string };
  card_faces?: Array<{ image_uris?: { large?: string; normal?: string; small?: string } }>;
  prices?: { usd?: string | null; usd_foil?: string | null };
}

interface ScryfallList {
  object: string;
  data?: ScryfallCard[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ScryfallSourceOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
  userAgent?: string;
}

/** Scryfall's finish names mapped onto our printing vocabulary. */
const FINISH_TO_PRINTING: Record<string, string> = {
  nonfoil: 'NORMAL',
  foil: 'FOIL',
  etched: 'ETCHED',
  glossy: 'GLOSSY',
};

export function createScryfallSource(options: ScryfallSourceOptions = {}): CatalogSource {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  async function request(
    ctx: CatalogCtx,
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    const response = await doFetch(`${baseUrl}${path}`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: ctx.signal,
    });

    // 404 is Scryfall's "no cards matched", not an error condition.
    if (response.status === 404) return { status: 404, body: null };

    if (!response.ok) {
      throw new Error(`Scryfall responded ${response.status} for ${path}`);
    }

    return { status: response.status, body: await response.json() };
  }

  return {
    key: SCRYFALL_KEY,
    displayName: 'Scryfall',
    description: 'Magic: The Gathering card database. Free, no account required.',
    games: ['Magic'],
    // Declared so intake can prefer a source yielding the ids we key on.
    providesExternalIds: ['tcgplayer', 'cardmarket'],
    rateLimit: { requestsPerSecond: 10 },

    async search(ctx: CatalogCtx, query: CatalogSearchQuery): Promise<CatalogCandidate[]> {
      const text = query.text.trim();
      if (text === '') return [];

      // `unique=prints` returns every printing rather than one per card name.
      // Intake is choosing a specific physical card, so the printing matters.
      const parts = [text];
      if (query.setName) parts.push(`set:"${query.setName.replace(/"/g, '')}"`);

      const params = new URLSearchParams({
        q: parts.join(' '),
        unique: 'prints',
        order: 'released',
      });

      const { status, body } = await request(ctx, `/cards/search?${params.toString()}`);
      if (status === 404) return [];

      const cards = (body as ScryfallList).data ?? [];
      const limited = query.limit ? cards.slice(0, query.limit) : cards;

      return limited.map(toCandidate);
    },

    async fetchById(ctx: CatalogCtx, sourceId: string): Promise<CatalogCandidate | null> {
      if (!sourceId.trim()) return null;

      const { status, body } = await request(ctx, `/cards/${encodeURIComponent(sourceId)}`);
      if (status === 404 || !body) return null;

      return toCandidate(body as ScryfallCard);
    },
  };
}

function toCandidate(card: ScryfallCard): CatalogCandidate {
  // Only ids Scryfall actually reported. An absent key is meaningful; a blank
  // one written to CatalogExternalRef would never match anything.
  const externalIds: Record<string, string> = { [SCRYFALL_KEY]: card.id };
  if (typeof card.tcgplayer_id === 'number') {
    externalIds.tcgplayer = String(card.tcgplayer_id);
  }
  if (typeof card.cardmarket_id === 'number') {
    externalIds.cardmarket = String(card.cardmarket_id);
  }

  // Prefer `large` (672×936) over `normal` (488×680): these images end up as a
  // product photo on a storefront, where the thumbnail Scryfall calls `normal`
  // reads as low quality. `large` is still a modest JPG, not the ~10× heavier
  // `png`. Double-faced cards carry images per face rather than at the top level.
  const imageUrl =
    card.image_uris?.large ??
    card.image_uris?.normal ??
    card.image_uris?.small ??
    card.card_faces?.[0]?.image_uris?.large ??
    card.card_faces?.[0]?.image_uris?.normal ??
    card.card_faces?.[0]?.image_uris?.small;

  const printings = (card.finishes ?? [])
    .map((finish) => FINISH_TO_PRINTING[finish])
    .filter((p): p is string => p !== undefined);

  // Prefer the non-foil price; a foil-only printing has usd null and usd_foil set.
  const marketPrice = usdStringToCents(card.prices?.usd) ?? usdStringToCents(card.prices?.usd_foil);

  // The same two figures per printing, so a caller repricing a FOIL SKU is
  // never handed the plain printing's market by accident.
  const pricesByPrinting: Record<string, number> = {};
  const usd = usdStringToCents(card.prices?.usd);
  const usdFoil = usdStringToCents(card.prices?.usd_foil);
  if (usd !== undefined) pricesByPrinting.NORMAL = usd;
  if (usdFoil !== undefined) pricesByPrinting.FOIL = usdFoil;

  const candidate: CatalogCandidate = {
    sourceId: card.id,
    name: card.name,
    game: 'Magic',
    externalIds,
  };

  if (card.set_name) candidate.setName = card.set_name;
  // Scryfall's `collector_number` is the printed number, verbatim — including
  // suffixes like `123★`. Kept as-is for cross-source equality.
  if (card.collector_number) candidate.collectorNumber = card.collector_number;
  if (imageUrl) candidate.imageUrl = imageUrl;
  if (printings.length > 0) candidate.printings = printings;
  if (marketPrice !== undefined) candidate.marketPrice = marketPrice;
  if (Object.keys(pricesByPrinting).length > 0) candidate.pricesByPrinting = pricesByPrinting;
  if (card.lang) candidate.language = card.lang.toUpperCase();

  return candidate;
}
