import { parseCondition, toPrinting } from '@hub/connector-tcgplayer';
import type { ChannelListing } from '@hub/connector-sdk';

/**
 * Proposing links between a channel's existing listings and the catalogue.
 *
 * Pure functions, no I/O, the way `allocation.ts` and `reconcile.ts` are — the
 * judgement is the part worth testing exhaustively, and it should be testable
 * without a database or a live store.
 *
 * ## Why this exists
 *
 * An operator arriving with a populated Shopify store had exactly one route into
 * the ledger: read a variant id out of the Shopify admin and type it onto an
 * allocation, per item. `connector-shopify` says so in as many words — "Create
 * the product in Shopify, then set the variant id on this allocation." That is
 * fine for ten items and impossible for thirteen hundred.
 *
 * ## The rule that shapes everything here
 *
 * **Nothing is ever applied. Everything is proposed, with its reason.**
 *
 * This is the same rule the TCGPlayer condition parser follows — it reports an
 * unrecognised string rather than guessing, because a guesser files a Japanese
 * card as English. The cost of a wrong match here is worse than a mislabel: a
 * link points inventory at the wrong listing, so the next sale decrements the
 * wrong SKU and the error surfaces days later as unexplained drift.
 *
 * So a tie is reported as a tie. Two candidates at equal confidence produce an
 * `ambiguous` proposal listing both, never a coin flip.
 */

/**
 * How much the evidence is worth.
 *
 * Ordered, and the order is the API — callers offer bulk-accept for `certain`
 * and require a per-item decision below it.
 */
export type MatchConfidence = 'certain' | 'probable' | 'possible';

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  certain: 0,
  probable: 1,
  possible: 2,
};

/** Why a match was proposed, in the operator's terms rather than a score. */
export type MatchReason =
  /** The channel's barcode equals the catalogue's. Only real evidence of identity here. */
  | 'barcode'
  /** The channel's SKU field equals a platform id the catalogue holds. */
  | 'external-id'
  /** The channel's SKU field contains such an id, alongside other text. */
  | 'external-id-embedded'
  /** Names agree exactly once normalised, and so does the set. */
  | 'name-and-set'
  /** Names agree exactly once normalised; the set is unknown or not compared. */
  | 'name'
  /** One name contains the other. Weak, and offered only when nothing better did. */
  | 'name-partial';

const REASON_CONFIDENCE: Record<MatchReason, MatchConfidence> = {
  barcode: 'certain',
  'external-id': 'certain',
  'external-id-embedded': 'probable',
  'name-and-set': 'probable',
  name: 'possible',
  'name-partial': 'possible',
};

/**
 * Something a listing could be linked to.
 *
 * Deliberately covers both an item already in the ledger and a candidate from a
 * catalogue source, because the operator's store contains both — a few dozen
 * things they have already set up, and thirteen hundred they have not. A caller
 * that only has one kind simply leaves the other fields off.
 */
export interface MatchTarget {
  /** Caller's handle for this target; echoed back untouched. */
  id: string;
  name: string;
  setName?: string;
  game?: string;
  /** Platform ids the catalogue holds, keyed by namespace ("tcgplayer", …). */
  externalIds?: Readonly<Record<string, string>>;
  /** UPC/EAN, where the catalogue knows one. Rare outside sealed product. */
  barcode?: string;
  /** Present when this target is already a SKU in the ledger. */
  skuId?: string;
}

export interface MatchCandidate {
  target: MatchTarget;
  reason: MatchReason;
  confidence: MatchConfidence;
  /** Human-readable justification, for the review screen. */
  detail: string;
  /**
   * How much of the two names the match actually accounts for, 0–1.
   *
   * `min(len) / max(len)` over the normalised names, and **1 for any reason that
   * is not a name resemblance** — an id or a barcode either matches or does not,
   * so there is nothing partial about it.
   *
   * This exists because containment is not a measure of similarity. A catalogue
   * product called "Winterspell" is *contained by* every listing in the
   * Winterspell set, so on a live run it tied with the correct product for all
   * four sealed items in that set and made every one of them `ambiguous`. Both
   * candidates were `possible · name-partial`, so nothing in the reason
   * vocabulary could separate them — but they were never equally good evidence:
   * one name accounted for 76% of the listing's, the other for 22%.
   *
   * Any set containing a card named after the set reproduces this, which is not
   * rare.
   */
  overlap: number;
}

/**
 * What the listing's own title implies about condition, printing and language.
 *
 * Carried on every proposal so the review screen can *offer* it rather than
 * defaulting the condition dropdown to Near Mint. Absent when the title said
 * nothing readable, which is the honest answer for a sealed box and for anything
 * the condition vocabulary does not cover.
 */
export interface DerivedDimensions {
  condition: string;
  printing: string;
  language: string;
}

interface ProposalBase {
  listing: ChannelListing;
  /** Absent when the title implied nothing. Never guessed. */
  derived?: DerivedDimensions;
}

export type MatchProposal =
  /** One clear best candidate. Still requires confirmation. */
  | (ProposalBase & { status: 'matched'; candidate: MatchCandidate })
  /**
   * Several candidates tied at the best confidence found.
   *
   * Reported rather than resolved. Picking one would be a guess, and a guess
   * here silently points stock at the wrong listing.
   */
  | (ProposalBase & { status: 'ambiguous'; candidates: MatchCandidate[] })
  /** Nothing in the catalogue resembled it. Not an error — most stores have oddments. */
  | (ProposalBase & { status: 'unmatched' });

/**
 * Normalise a name for comparison.
 *
 * Same treatment `CatalogItem.searchName` gets, and for the same reason: the
 * seller typed "U.S.S. Enterprise-D" and the catalogue says "USS Enterprise D",
 * and neither is wrong.
 */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Strip the parts of a channel title that describe the SKU rather than the
 * product.
 *
 * A Shopify variant is titled "Pikachu ex - Near Mint Foil", and the catalogue
 * knows a product called "Pikachu ex". Comparing the whole string finds nothing.
 * The condition vocabulary is borrowed from the TCGPlayer connector because it is
 * the same vocabulary sellers type, and because it already refuses to guess.
 */
export function splitChannelTitle(title: string): {
  productName: string;
  /** The trailing condition/finish text, when there was any. */
  qualifier?: string;
} {
  // Shopify's `displayName` joins product and variant with " - ", and so do most
  // hand-written titles.
  const parts = title.split(/\s+-\s+/);
  if (parts.length < 2) return { productName: title.trim() };

  // The qualifier can itself contain " - ": the condition grammar is
  // `<condition>[ <edition>][ <finish>][ - <language>]`, so "Near Mint Holofoil
  // - Japanese" is one qualifier in two segments. Trying only the last segment
  // sees "Japanese", fails to parse it, and loses the language — which is the
  // one field it is least acceptable to lose.
  //
  // Shortest tail first, so the smallest thing that really is a qualifier wins
  // and the product keeps as much of its name as possible. `i >= 1` because a
  // tail that swallows the whole title leaves nothing to match on.
  for (let i = parts.length - 1; i >= 1; i--) {
    const tail = parts.slice(i).join(' - ').trim();
    if (parseCondition(tail).status !== 'parsed') continue;

    return { productName: parts.slice(0, i).join(' - ').trim(), qualifier: tail };
  }

  // Nothing in the tail is a condition. "Commander - Star Trek" and "Star Trek -
  // Play Booster Display" keep their full names, which is the whole reason this
  // is a search rather than an unconditional split.
  return { productName: title.trim() };
}

/**
 * Derive the `Sku` dimensions a listing implies, where its title says.
 *
 * Returns `undefined` rather than defaulting to Near Mint. A default here would
 * be the software deciding a card's condition on the operator's behalf, and
 * condition is most of what a single is worth.
 */
export function deriveSkuDimensions(
  listing: ChannelListing,
): { condition: string; printing: string; language: string } | undefined {
  const { qualifier } = splitChannelTitle(listing.title);
  if (qualifier === undefined) return undefined;

  const parsed = parseCondition(qualifier);
  if (parsed.status !== 'parsed') return undefined;

  return {
    condition: parsed.value.condition,
    printing: toPrinting(parsed.value.edition, parsed.value.finish),
    language: parsed.value.language,
  };
}

/**
 * Find every defensible candidate for one listing, best evidence first.
 *
 * Exported because the review screen shows the alternatives for an ambiguous
 * proposal, and because it is far easier to test than the wrapper.
 */
export function scoreCandidates(
  listing: ChannelListing,
  targets: readonly MatchTarget[],
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];

  const listingBarcode = listing.barcode?.trim();
  const listingSku = listing.sku?.trim();
  const { productName } = splitChannelTitle(listing.title);
  const normalizedName = normalizeTitle(productName);
  const squashedName = squash(productName);

  for (const target of targets) {
    const reason = bestReasonFor(target, {
      listingBarcode,
      listingSku,
      normalizedName,
      squashedName,
    });
    if (!reason) continue;

    candidates.push({
      target,
      reason: reason.reason,
      confidence: REASON_CONFIDENCE[reason.reason],
      detail: reason.detail,
      overlap: reason.overlap,
    });
  }

  // Confidence first, then how much of the name the match explains. The second
  // key only ever separates candidates the first could not.
  return candidates.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || b.overlap - a.overlap,
  );
}

/**
 * How much two normalised names have in common, by length alone.
 *
 * Deliberately crude. It is not a similarity metric and must not grow into one:
 * it exists only to separate candidates that are already known to match by
 * containment, where the shorter name is by definition the weaker evidence.
 * Anything cleverer — edit distance, token overlap — would start *creating*
 * matches rather than ordering them, which is the engine's job to refuse.
 */
function overlapOf(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 0;

  return Math.min(a.length, b.length) / longer;
}

function bestReasonFor(
  target: MatchTarget,
  ctx: {
    listingBarcode?: string;
    listingSku?: string;
    normalizedName: string;
    squashedName: string;
  },
): { reason: MatchReason; detail: string; overlap: number } | undefined {
  // 1. Barcode. The only field here that identifies a physical product outright.
  if (ctx.listingBarcode && target.barcode && ctx.listingBarcode === target.barcode.trim()) {
    return {
      reason: 'barcode',
      detail: `barcode ${ctx.listingBarcode} matches exactly`,
      overlap: 1,
    };
  }

  // 2. The seller's SKU field holding a platform id. Common where a store was
  // previously run by another tool, which is exactly the migration case.
  if (ctx.listingSku) {
    for (const [namespace, value] of Object.entries(target.externalIds ?? {})) {
      if (!value) continue;

      if (ctx.listingSku === value) {
        return { reason: 'external-id', detail: `SKU is the ${namespace} id ${value}`, overlap: 1 };
      }

      // Embedded rather than equal: "PKM-697344-NM" carries the id but is not it.
      // Bounded by digit-length so a short id cannot match a coincidental run.
      if (value.length >= 4 && ctx.listingSku.includes(value)) {
        return {
          reason: 'external-id-embedded',
          detail: `SKU "${ctx.listingSku}" contains the ${namespace} id ${value}`,
          overlap: 1,
        };
      }
    }
  }

  // 3. Names. Everything below here is a resemblance, not an identity.
  const targetNormalized = normalizeTitle(target.name);
  const targetSquashed = squash(target.name);
  if (targetNormalized === '') return undefined;

  const namesAgree = ctx.normalizedName === targetNormalized || ctx.squashedName === targetSquashed;

  if (namesAgree) {
    if (target.setName && normalizeTitle(target.setName) !== '') {
      return {
        reason: 'name-and-set',
        detail: `name matches "${target.name}" in ${target.setName}`,
        overlap: 1,
      };
    }
    return { reason: 'name', detail: `name matches "${target.name}"`, overlap: 1 };
  }

  // 4. Containment, either direction. Weakest thing worth showing a human.
  if (
    ctx.normalizedName.length >= 4 &&
    (targetNormalized.includes(ctx.normalizedName) || ctx.normalizedName.includes(targetNormalized))
  ) {
    return {
      reason: 'name-partial',
      detail: `name resembles "${target.name}"`,
      overlap: overlapOf(ctx.normalizedName, targetNormalized),
    };
  }

  return undefined;
}

/**
 * Propose a link for one listing.
 *
 * A single best candidate becomes `matched`; a tie at the best confidence becomes
 * `ambiguous`; nothing becomes `unmatched`. Never applies anything.
 */
export function proposeMatch(
  listing: ChannelListing,
  targets: readonly MatchTarget[],
): MatchProposal {
  const derived = deriveSkuDimensions(listing);
  const base = { listing, ...(derived !== undefined ? { derived } : {}) };

  const candidates = scoreCandidates(listing, targets);
  if (candidates.length === 0) return { ...base, status: 'unmatched' };

  const best = candidates[0];
  if (!best) return { ...base, status: 'unmatched' };

  // Equal confidence *and* equal overlap. Adding the second test is not a
  // loosening of the "never resolve a tie" rule — it is a correction to what
  // counted as a tie. Two candidates whose names explain 76% and 22% of the
  // listing were never equally good evidence; reporting them as tied asked the
  // operator to arbitrate something the data already answers.
  //
  // Names of the same length still tie exactly, so the case the rule exists for
  // — two reprints with different ids and identical names — is untouched.
  const tied = candidates.filter(
    (c) => c.confidence === best.confidence && Math.abs(c.overlap - best.overlap) < 1e-9,
  );

  // More than one thing fits equally well. Which one is a question for the
  // person who owns the stock.
  if (tied.length > 1) return { ...base, status: 'ambiguous', candidates: tied };

  return { ...base, status: 'matched', candidate: best };
}

export interface ProposalSummary {
  matched: number;
  ambiguous: number;
  unmatched: number;
  /** Of the matched, how many are safe to accept in bulk. */
  certain: number;
}

/**
 * Propose links for a page of listings, skipping any already linked.
 *
 * `alreadyLinked` is the set of `externalListingId`s the channel already has an
 * allocation for. Re-proposing them would invite an operator to relink something
 * that is already working, and confirming that would either duplicate an
 * allocation or silently repoint a live listing.
 */
export function proposeMatches(
  listings: readonly ChannelListing[],
  targets: readonly MatchTarget[],
  alreadyLinked: ReadonlySet<string> = new Set(),
): { proposals: MatchProposal[]; summary: ProposalSummary; skipped: number } {
  const proposals: MatchProposal[] = [];
  let skipped = 0;

  for (const listing of listings) {
    if (alreadyLinked.has(listing.externalListingId)) {
      skipped++;
      continue;
    }
    proposals.push(proposeMatch(listing, targets));
  }

  return { proposals, summary: summarize(proposals), skipped };
}

export function summarize(proposals: readonly MatchProposal[]): ProposalSummary {
  const summary: ProposalSummary = { matched: 0, ambiguous: 0, unmatched: 0, certain: 0 };

  for (const proposal of proposals) {
    if (proposal.status === 'matched') {
      summary.matched++;
      if (proposal.candidate.confidence === 'certain') summary.certain++;
    } else if (proposal.status === 'ambiguous') {
      summary.ambiguous++;
    } else {
      summary.unmatched++;
    }
  }

  return summary;
}
