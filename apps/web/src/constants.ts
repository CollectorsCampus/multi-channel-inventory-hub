/**
 * Deliberately duplicated from packages/db/src/enums.ts rather than imported.
 *
 * @hub/db re-exports the generated Prisma client, which pulls Node built-ins
 * and the query engine into whatever imports it — none of which can run in a
 * browser. Until these value sets are split into a browser-safe package, a
 * small copy is cheaper than shipping the ORM to the client.
 *
 * The server is authoritative: every one of these is validated again by the
 * API's DTOs, so a copy that drifts produces a 400, not bad data.
 */

export const SKU_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'SEALED', 'NA'] as const;

/**
 * The TCGPlayer connector's language vocabulary (`LANGUAGE_NAMES` in
 * condition.ts), which is the one vocabulary this repository already parses and
 * prints — "Near Mint Holofoil - Japanese" round-trips through it. Same
 * duplication rationale as above; `Sku.language` itself is a free string, so a
 * code outside this list is stored fine, this is just what the picker offers.
 */
export const SKU_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'EN', label: 'English' },
  { code: 'JA', label: 'Japanese' },
  { code: 'KO', label: 'Korean' },
  { code: 'ZHS', label: 'Chinese (Simplified)' },
  { code: 'ZHT', label: 'Chinese (Traditional)' },
  { code: 'FR', label: 'French' },
  { code: 'DE', label: 'German' },
  { code: 'IT', label: 'Italian' },
  { code: 'ES', label: 'Spanish' },
  { code: 'PT', label: 'Portuguese' },
  { code: 'RU', label: 'Russian' },
  { code: 'TH', label: 'Thai' },
  { code: 'ID', label: 'Indonesian' },
];

export const STOCK_MOVEMENT_REASONS = ['intake', 'adjustment', 'return', 'shrinkage'] as const;

export const ALLOCATION_MODES = ['fixed', 'pooled'] as const;
