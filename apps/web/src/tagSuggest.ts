/**
 * Proposing the store's tag for a catalogue value — and refusing to when it is
 * not obvious.
 *
 * Mapping every set by hand is the tedious part of tag rules, and most of them
 * are a punctuation change: the catalogue says `ME02: Phantasmal Flames` and
 * the store's tag is `ME02 Phantasmal Flames`. The catalogue says `Pokemon`
 * and the tag is `Pokémon`.
 *
 * ## It suggests, it never applies
 *
 * The suggestion is only ever offered against **the store's own tag list**, so
 * what is proposed is always a tag that already exists — never one this code
 * invented. The operator still confirms it, and only then does a rule exist.
 *
 * That distinction is the whole safety argument, and there is a real case
 * behind it: the operator's store carries `SV: Prismatic Evolutions` as **both**
 * `SV085 Prismatic Evolutions` and `SV85 Prismatic Evolutions`. Neither
 * normalises to the catalogue's spelling, so nothing is suggested and the
 * operator picks — which is correct, because a machine cannot know which of the
 * two they meant, and choosing wrong puts the product in a collection nobody
 * is looking at.
 */

import type { ItemKind, TagRule } from './api/channels';

/**
 * Mirrors `itemKind` on the API. Kept in step by
 * `tagSuggest.spec.ts`, which pins the same three cases the server's own tests
 * pin — the vocabulary is closed and two values long, so a mirror is cheap.
 */
export function previewItemKind(condition: string): ItemKind {
  if (condition === 'SEALED') return 'sealed';
  if (condition === 'NA') return 'other';
  return 'single';
}

/**
 * The tags a card would get, for showing the operator before they commit.
 *
 * **A preview, and the server decides.** `resolveTags` on the API is
 * authoritative and runs against the row it actually creates; this mirrors it
 * so the intake screen can say what will happen while the card is still on
 * screen. The rules are simple enough that a mirror is cheap, and the cost of
 * the two drifting is a preview that is briefly wrong rather than a product
 * tagged incorrectly.
 */
export function previewTags(
  rules: readonly TagRule[],
  always: readonly string[],
  item: { name: string; game?: string | null; setName?: string | null; condition?: string | null },
): string[] {
  const matched = rules
    .filter((rule) => {
      switch (rule.match) {
        case 'game':
          return item.game === rule.value;
        case 'set':
          return item.setName === rule.value;
        case 'name-contains':
          return item.name.toLowerCase().includes(rule.value.toLowerCase());
        case 'kind':
          // Matches nothing without a condition, exactly as the server does —
          // assuming `single` would preview a "Singles" tag on a booster box.
          return item.condition != null && previewItemKind(item.condition) === rule.value;
      }
    })
    .map((rule) => rule.tag);

  return [...new Set([...always, ...matched])];
}

/**
 * Reduce a name to what it is "really" saying: case, accents and punctuation
 * all differ between a catalogue and a storefront without changing the meaning.
 *
 * Deliberately aggressive, because it is only ever used to *find a candidate*
 * that the operator then confirms — never to decide anything on its own.
 */
export function normalizeForMatch(value: string): string {
  return (
    value
      .normalize('NFD')
      // Strip combining marks, so é and e are the same letter.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Everything that is not a letter or digit: colons, spaces, hyphens.
      .replace(/[^a-z0-9]/g, '')
  );
}

/**
 * The one tag in `vocabulary` that plainly means `value`, or null.
 *
 * Null when nothing matches **and** when more than one does. Ambiguity is not a
 * tie to break: two tags that normalise the same way are two real collections,
 * and picking either would be the software guessing which one the operator
 * meant.
 */
export function suggestTag(value: string, vocabulary: readonly string[]): string | null {
  const target = normalizeForMatch(value);
  if (target === '') return null;

  const matches = vocabulary.filter((tag) => normalizeForMatch(tag) === target);

  // Exactly one, or nothing. An exact match is still returned through the same
  // path — it is the same answer, arrived at more obviously.
  return matches.length === 1 ? matches[0]! : null;
}
