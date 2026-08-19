import type { CatalogCandidate } from '@hub/connector-sdk';

/**
 * The wire shapes Bushiroad's card database publishes, and the mapping onto
 * `CatalogCandidate`.
 *
 * Measured against the live English site on 2026-08-17, not inferred: 256
 * cards across three products, 162 of them in the booster set.
 */

export const PALWORLD_KEY = 'palworld';

/** The one game this source knows. Spelled as the operator would tag it. */
export const PALWORLD_GAME = 'Palworld';

/**
 * A row from `/card-list-user/list`.
 *
 * Every field is optional on read even where the live API always sends it: this
 * is an undocumented endpoint behind a WordPress plugin, so a missing field is
 * a thing to survive rather than to crash on.
 */
export interface PwCard {
  id?: number;
  /** Path under the image base, e.g. `EBP01/EBP01-001.png`. */
  picture?: string;
  /** Collector number, e.g. `EBP01-001`. */
  card_number?: string;
  card_name?: string;
  card_kind?: string;
  rare?: string;
  /** Set code, e.g. `EBP01`. */
  expansion?: string;
  expansion_name?: string;
  color?: string;
  type?: string;
}

/** An entry from `/card-list-user/products`, grouped by release year. */
export interface PwProduct {
  code?: string;
  name?: string;
  /** `pack` or `deck`. Not modelled — a set is a set to the catalogue. */
  type?: string;
  date?: string;
}

export interface PwProductsResponse {
  products?: Array<{ year?: string; items?: PwProduct[] }>;
}

export interface PwListResponse {
  page?: number;
  per_page?: number;
  total?: number;
  items?: PwCard[];
}

/**
 * The name a card is stored and searched under.
 *
 * **The collector number is folded in**, so `Mossanda – Guard Captain` becomes
 * `Mossanda – Guard Captain - ETD02-001`. That is not this code inventing a
 * format: it is exactly what tcgcsv does for Pokémon (`Mega Charizard X ex -
 * 013/094`), so a Palworld card reads the same way in the ledger, in search and
 * in a created listing's title as every Pokémon single already does — and the
 * number is the only thing that tells two printings of one Pal apart.
 *
 * A card with no number keeps its bare name rather than gaining a dangling
 * separator.
 */
export function cardName(card: PwCard): string {
  const name = (card.card_name ?? '').trim();
  const number = (card.card_number ?? '').trim();
  if (!name) return '';
  return number ? `${name} - ${number}` : name;
}

/**
 * One card as a catalogue candidate.
 *
 * Returns null for a row with no id or no name — there is nothing to key or
 * display, and a candidate that cannot be re-fetched is worse than one absent.
 *
 * **No price and no printings, ever.** The publisher's own database carries
 * neither, and inventing either would be this source claiming knowledge it does
 * not have. That is the practical cost of Palworld having no marketplace
 * catalogue yet: it can be stocked and listed, but not repriced.
 */
export function toCandidate(card: PwCard, imageBase: string): CatalogCandidate | null {
  const id = card.id;
  const name = cardName(card);
  if (id === undefined || id === null || name === '') return null;

  const candidate: CatalogCandidate = {
    sourceId: String(id),
    name,
    game: PALWORLD_GAME,
    externalIds: { [PALWORLD_KEY]: String(id) },
    // The English site. A card's Japanese printing is a different product with
    // its own numbering, so this is a fact about the source rather than a guess.
    language: 'EN',
  };

  const setName = (card.expansion_name ?? '').trim();
  if (setName) candidate.setName = setName;

  const picture = (card.picture ?? '').trim();
  if (picture) candidate.imageUrl = `${imageBase.replace(/\/$/, '')}/${picture}`;

  return candidate;
}

export function toCandidates(cards: readonly PwCard[], imageBase: string): CatalogCandidate[] {
  return cards
    .map((card) => toCandidate(card, imageBase))
    .filter((c): c is CatalogCandidate => c !== null);
}

/** Every product across the year groupings, flattened. */
export function flattenProducts(body: PwProductsResponse): PwProduct[] {
  return (body.products ?? []).flatMap((group) => group.items ?? []);
}
