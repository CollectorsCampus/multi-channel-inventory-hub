/**
 * TCGPlayer's `Condition` column, split apart and put back together.
 *
 * One string carries four independent dimensions:
 *
 * ```
 * Near Mint Holofoil                      condition + finish
 * Moderately Played Unlimited Holofoil    condition + edition + finish
 * Near Mint Holofoil - Japanese           condition + finish + language
 * Lightly Played 1st Edition              condition + edition
 * Unopened                                condition alone (sealed product)
 * (empty)                                 real data; TCGPlayer states nothing
 * ```
 *
 * The grammar is `<condition>[ <edition>][ <finish>][ - <language>]`, verified
 * against a real Pro account's exports on 2026-07-28.
 *
 * **Nothing here guesses.** A value this module does not recognise comes back as
 * `unrecognised` and becomes an import problem the operator sees. That rule is
 * the whole point: a parser that shrugs and defaults to English files a Japanese
 * card as an English one, and the seller discovers it when a buyer complains.
 * An empty column is a distinct outcome from an unreadable one — TCGPlayer
 * really does emit blanks, and treating those as errors would bury the real
 * failures under noise.
 *
 * ## Where the four fields land in our model
 *
 * Our `Sku` has three: `condition`, `printing`, `language`. TCGPlayer's
 * *edition* has no column of its own, so edition and finish share `printing` as
 * a composite token (`HOLOFOIL`, `1ST_EDITION_HOLOFOIL`, `UNLIMITED_HOLOFOIL`).
 * The encoding is total and reversible, so the round trip through TCGPlayer and
 * back is lossless — which matters, because {@link formatCondition} has to
 * rebuild the exact string TCGPlayer emitted or the upload matches nothing.
 *
 * That is a compromise, not a design: a real `edition` column would mean
 * changing `Sku`'s natural key, which is not a Phase 4 change.
 */

/**
 * Conditions, in our vocabulary.
 *
 * Mirrors `SKU_CONDITIONS` in `@hub/db`. Duplicated rather than imported because
 * connectors do not depend on the database package — they translate, they do not
 * persist. `apps/api` depends on both and asserts the two agree, so a drift
 * fails a test rather than a production write.
 */
export const TCG_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'SEALED'] as const;
export type TcgCondition = (typeof TCG_CONDITIONS)[number];

export const TCG_EDITIONS = ['1ST_EDITION', 'LIMITED', 'UNLIMITED'] as const;
export type TcgEdition = (typeof TCG_EDITIONS)[number];

export const TCG_FINISHES = ['NORMAL', 'FOIL', 'HOLOFOIL', 'REVERSE_HOLOFOIL'] as const;
export type TcgFinish = (typeof TCG_FINISHES)[number];

/** The four dimensions, separated. */
export interface SplitCondition {
  condition: TcgCondition;
  /** Null when the printing carries no edition, which is most of Magic. */
  edition: TcgEdition | null;
  finish: TcgFinish;
  /** Our language code; `EN` when TCGPlayer names no language. */
  language: string;
}

export type ConditionParse =
  | { status: 'parsed'; value: SplitCondition }
  /** The column was empty. Normal in real exports, and not a problem. */
  | { status: 'absent' }
  /** Something is there that we cannot read. Always reported, never guessed. */
  | { status: 'unrecognised'; raw: string; detail: string };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Condition phrases, longest first.
 *
 * Order is load-bearing: matching is a prefix strip, and `Near Mint` must be
 * tried before any shorter phrase that could also match the start of it.
 */
const CONDITION_PHRASES: ReadonlyArray<readonly [string, TcgCondition]> = [
  ['Near Mint', 'NM'],
  ['Lightly Played', 'LP'],
  ['Moderately Played', 'MP'],
  ['Heavily Played', 'HP'],
  ['Damaged', 'DMG'],
  // Sealed product has no grading, so TCGPlayer states its packaging instead.
  ['Unopened', 'SEALED'],
];

const EDITION_PHRASES: ReadonlyArray<readonly [string, TcgEdition]> = [
  ['1st Edition', '1ST_EDITION'],
  ['Unlimited', 'UNLIMITED'],
  ['Limited', 'LIMITED'],
];

/** Longest first, so `Reverse Holofoil` is not read as `Holofoil`. */
const FINISH_PHRASES: ReadonlyArray<readonly [string, TcgFinish]> = [
  ['Reverse Holofoil', 'REVERSE_HOLOFOIL'],
  ['Holofoil', 'HOLOFOIL'],
  ['Foil', 'FOIL'],
];

/**
 * Languages TCGPlayer names, mapped to our codes.
 *
 * The core has no language vocabulary of its own — `Sku.language` is a free
 * string defaulting to `EN` — so this is the TCGPlayer connector's, and it is
 * exported so anything else needing to agree with it can.
 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  English: 'EN',
  Japanese: 'JA',
  Korean: 'KO',
  'Chinese (S)': 'ZHS',
  'Chinese Simplified': 'ZHS',
  'Chinese (T)': 'ZHT',
  'Chinese Traditional': 'ZHT',
  French: 'FR',
  German: 'DE',
  Italian: 'IT',
  Spanish: 'ES',
  Portuguese: 'PT',
  Russian: 'RU',
  Thai: 'TH',
  Indonesian: 'ID',
};

/**
 * Reverse lookups for the export path, derived from the same tuples the import
 * path reads so the two directions cannot drift apart. A test asserts every
 * code has a phrase and that parse(format(x)) is x across the whole vocabulary.
 */
const CONDITION_PHRASE_BY_CODE = reverse(CONDITION_PHRASES);
const EDITION_PHRASE_BY_CODE = reverse(EDITION_PHRASES);
/** `NORMAL` is a real finish TCGPlayer simply does not spell out, so it has no phrase of its own. */
const FINISH_PHRASE_BY_CODE = { ...reverse(FINISH_PHRASES), NORMAL: '' };

function reverse<T extends string>(
  phrases: ReadonlyArray<readonly [string, T]>,
): Record<T, string> {
  return Object.fromEntries(phrases.map(([phrase, code]) => [code, phrase])) as Record<T, string>;
}

const CODE_TO_LANGUAGE: Readonly<Record<string, string>> = {
  EN: 'English',
  JA: 'Japanese',
  KO: 'Korean',
  ZHS: 'Chinese (S)',
  ZHT: 'Chinese (T)',
  FR: 'French',
  DE: 'German',
  IT: 'Italian',
  ES: 'Spanish',
  PT: 'Portuguese',
  RU: 'Russian',
  TH: 'Thai',
  ID: 'Indonesian',
};

// ---------------------------------------------------------------------------
// Import: split
// ---------------------------------------------------------------------------

/**
 * Split one `Condition` value into its four parts.
 *
 * Never throws and never guesses. Callers turn `unrecognised` into an
 * {@link import('@hub/connector-sdk').ImportProblem} naming the exact string,
 * so an operator can tell us what we are missing instead of finding out from a
 * mispriced listing.
 */
export function parseCondition(raw: string): ConditionParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { status: 'absent' };

  // Language comes off first: it is the only part with a delimiter, and taking
  // it away leaves a string with no punctuation to reason about.
  const { rest: withoutLanguage, language, problem } = splitLanguage(trimmed);
  if (problem) return { status: 'unrecognised', raw: trimmed, detail: problem };

  const condition = stripPhrase(withoutLanguage, CONDITION_PHRASES);
  if (!condition) {
    return {
      status: 'unrecognised',
      raw: trimmed,
      detail: `no known condition at the start of "${withoutLanguage}"`,
    };
  }

  // Edition before finish: TCGPlayer writes them in that order
  // ("Moderately Played Unlimited Holofoil"), and reversing the two would leave
  // the edition stranded as unparsed text.
  const edition = stripPhrase(condition.rest, EDITION_PHRASES);
  const afterEdition = edition ? edition.rest : condition.rest;

  const finish = stripPhrase(afterEdition, FINISH_PHRASES);
  const leftover = (finish ? finish.rest : afterEdition).trim();

  if (leftover !== '') {
    return {
      status: 'unrecognised',
      raw: trimmed,
      detail: `unrecognised "${leftover}"`,
    };
  }

  return {
    status: 'parsed',
    value: {
      condition: condition.value,
      edition: edition?.value ?? null,
      finish: finish?.value ?? 'NORMAL',
      language,
    },
  };
}

function splitLanguage(value: string): { rest: string; language: string; problem?: string } {
  // ` - ` with spaces, not a bare hyphen: card names contain hyphens
  // ("Jace, Vryn's Prodigy" is fine, but "Ho-Oh" and "Porygon-Z" are not
  // hypothetical) and a greedy split would amputate one.
  const index = value.lastIndexOf(' - ');
  if (index === -1) return { rest: value, language: 'EN' };

  const name = value.slice(index + 3).trim();
  const code = LANGUAGE_NAMES[name];

  if (!code) {
    return { rest: value, language: 'EN', problem: `unknown language "${name}"` };
  }
  return { rest: value.slice(0, index).trim(), language: code };
}

/** Strip a leading phrase from a fixed vocabulary, if one matches. */
function stripPhrase<T>(
  value: string,
  phrases: ReadonlyArray<readonly [string, T]>,
): { value: T; rest: string } | undefined {
  const lowered = value.toLowerCase();

  for (const [phrase, mapped] of phrases) {
    const candidate = phrase.toLowerCase();
    if (!lowered.startsWith(candidate)) continue;

    const rest = value.slice(phrase.length);
    // Must end at a word boundary, or `Foil` would match the start of a
    // hypothetical `Foiled` and leave nonsense behind.
    if (rest !== '' && !rest.startsWith(' ')) continue;

    return { value: mapped, rest: rest.trimStart() };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Our model <-> the split form
// ---------------------------------------------------------------------------

/**
 * Encode edition and finish into one `Sku.printing` token.
 *
 * `NORMAL`, `FOIL`, `HOLOFOIL`, `REVERSE_HOLOFOIL`, `1ST_EDITION`,
 * `1ST_EDITION_HOLOFOIL`, `UNLIMITED_HOLOFOIL`, and so on. Uppercase
 * underscore tokens match the vocabulary the Scryfall catalog source already
 * writes (`NORMAL`, `FOIL`, `ETCHED`).
 */
export function toPrinting(edition: TcgEdition | null, finish: TcgFinish): string {
  if (!edition) return finish;
  // A plain 1st-edition card has no finish worth naming, and `1ST_EDITION` reads
  // better than `1ST_EDITION_NORMAL`.
  return finish === 'NORMAL' ? edition : `${edition}_${finish}`;
}

/** The inverse of {@link toPrinting}. Undefined when the token is not ours. */
export function fromPrinting(
  printing: string,
): { edition: TcgEdition | null; finish: TcgFinish } | undefined {
  const token = printing.trim().toUpperCase();
  if (token === '') return { edition: null, finish: 'NORMAL' };

  for (const edition of TCG_EDITIONS) {
    if (token === edition) return { edition, finish: 'NORMAL' };
    if (token.startsWith(`${edition}_`)) {
      const finish = token.slice(edition.length + 1);
      return isFinish(finish) ? { edition, finish } : undefined;
    }
  }

  return isFinish(token) ? { edition: null, finish: token } : undefined;
}

function isFinish(value: string): value is TcgFinish {
  return (TCG_FINISHES as readonly string[]).includes(value);
}

function isCondition(value: string): value is TcgCondition {
  return (TCG_CONDITIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Export: recombine
// ---------------------------------------------------------------------------

export type ConditionFormat = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Rebuild the `Condition` string TCGPlayer expects from our three SKU fields.
 *
 * The exact inverse of {@link parseCondition}, and it must stay that way: an
 * upload row whose Condition does not match TCGPlayer's own spelling matches
 * nothing on their side, and the operator gets a silent no-op rather than an
 * error.
 *
 * Fails rather than approximating. A SKU printed `ETCHED` — which Scryfall
 * really does report for Magic — has no TCGPlayer condition spelling we have
 * verified, and inventing one would put a price on the wrong listing.
 */
export function formatCondition(sku: {
  condition: string;
  printing: string;
  language: string;
}): ConditionFormat {
  const condition = sku.condition.trim().toUpperCase();
  if (!isCondition(condition)) {
    // `NA` is in the core's vocabulary as "not applicable"; TCGPlayer has no
    // spelling for it, so it cannot be exported rather than being sent as a
    // guess.
    return { ok: false, reason: `condition "${sku.condition}" has no TCGPlayer equivalent` };
  }

  const printing = fromPrinting(sku.printing);
  if (!printing) {
    return { ok: false, reason: `printing "${sku.printing}" has no TCGPlayer equivalent` };
  }

  const language = sku.language.trim().toUpperCase() || 'EN';
  const languageName = CODE_TO_LANGUAGE[language];
  if (!languageName) {
    return { ok: false, reason: `language "${sku.language}" has no TCGPlayer equivalent` };
  }

  // Every branch below is total: isCondition and fromPrinting have already
  // proved each token came out of the vocabulary these maps were built from.
  const parts = [CONDITION_PHRASE_BY_CODE[condition]];

  if (printing.edition) parts.push(EDITION_PHRASE_BY_CODE[printing.edition]);
  if (printing.finish !== 'NORMAL') parts.push(FINISH_PHRASE_BY_CODE[printing.finish]);

  // English is TCGPlayer's default and carries no suffix. Emitting
  // "Near Mint - English" would not match their own value.
  const suffix = language === 'EN' ? '' : ` - ${languageName}`;
  return { ok: true, value: `${parts.filter(Boolean).join(' ')}${suffix}` };
}
