import type { ConnectorLogger } from './types';

/**
 * A source of product reference data — Scryfall, tcgcsv, a future Cardmarket
 * importer.
 *
 * Deliberately *not* a `Connector`. A connector is a sales channel: it holds
 * listings, receives orders, and participates in the allocation loop. A catalog
 * source holds none of that. It answers "what product is this?" and nothing
 * else, and it has no ledger relationship at all.
 *
 * Modelling Scryfall as a connector declaring only `catalog.search` would have
 * meant a channel with no listings, no orders, no sync mode and no meaningful
 * reconciliation — every part of the connector contract inapplicable but one.
 * Two small interfaces beat one interface that is mostly holes.
 *
 * A package may export both. If TCGPlayer API access were ever restored, its
 * package would export a `Connector` for selling and a `CatalogSource` for
 * lookups, and neither would have to pretend to be the other.
 */

/** Per-call context. Simpler than a connector's: most catalog sources are public. */
export interface CatalogCtx {
  logger: ConnectorLogger;
  /** Only for sources behind an API key. Public sources receive an empty object. */
  secrets: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface CatalogSearchQuery {
  text: string;
  /** Narrow to one game where the source supports several. */
  game?: string;
  setName?: string;
  /** Sources should honour this; the intake UI shows a short list. */
  limit?: number;
}

/**
 * One product a source proposes.
 *
 * `externalIds` is the important field. §4 says to reuse canonical platform IDs
 * rather than invent our own, and this is how they arrive: a Scryfall result
 * carries both its own id and, usually, a TCGPlayer one.
 *
 * "Usually" is load-bearing. Coverage is not universal — measured at 158 of 175
 * cards on one modern Magic set, and absent entirely from older printings (ADR
 * 0002). Consumers must treat every key as optional and never assume a
 * particular platform's id is present.
 */
export interface CatalogCandidate {
  /** This source's own identifier for the product. Always present. */
  sourceId: string;
  name: string;
  game?: string;
  setName?: string;
  imageUrl?: string;

  /**
   * Platform product ids this source knows, keyed by platform name
   * ("scryfall", "tcgplayer", ...). Always includes this source's own key.
   */
  externalIds: Readonly<Record<string, string>>;

  /** Reference market price in cents. Never a float. */
  marketPrice?: number;

  /** Finishes this product comes in ("NORMAL", "FOIL", ...), for intake to offer. */
  printings?: readonly string[];

  language?: string;
}

export interface CatalogSource {
  /** Stable key, also used as the `source` on CatalogExternalRef. */
  readonly key: string;

  readonly displayName: string;
  readonly description?: string;

  /**
   * Games this source covers, for routing a search to the right sources.
   * Empty means "unknown or all" and the source is always consulted.
   */
  readonly games: readonly string[];

  /**
   * Platform id namespaces this source can supply, beyond its own key.
   * Declared so the intake flow can prefer a source that yields the ids we
   * actually want to key the catalog on.
   */
  readonly providesExternalIds?: readonly string[];

  /** Secret field names, if the source needs authentication. Most do not. */
  readonly secretFields?: readonly string[];

  /**
   * Requests per second the core should allow. Public catalog APIs are a shared
   * community resource — Scryfall asks for roughly 10/s with a descriptive
   * User-Agent — so this is a courtesy obligation, not just a safety limit.
   */
  readonly rateLimit?: { requestsPerSecond: number; burst?: number };

  search(ctx: CatalogCtx, query: CatalogSearchQuery): Promise<CatalogCandidate[]>;

  /** Fetch one product by this source's own id, when the source supports it. */
  fetchById?(ctx: CatalogCtx, sourceId: string): Promise<CatalogCandidate | null>;
}

export interface CatalogSourceProblem {
  code: 'invalid_definition';
  message: string;
}

/**
 * Validate a catalog source before the registry trusts it.
 *
 * Far lighter than {@link import('./connector').validateConnector} because the
 * contract is far smaller — which is the point of separating them.
 */
export function validateCatalogSource(source: CatalogSource): CatalogSourceProblem[] {
  const problems: CatalogSourceProblem[] = [];
  const invalid = (message: string) => problems.push({ code: 'invalid_definition', message });

  if (!source.key || typeof source.key !== 'string') {
    invalid('Catalog source must declare a string `key`.');
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(source.key)) {
    // The key is persisted as CatalogExternalRef.source and appears in URLs.
    invalid(`Catalog source key "${source.key}" must be lowercase alphanumeric with dashes.`);
  }

  if (!source.displayName) invalid('Catalog source must declare a `displayName`.');
  if (!Array.isArray(source.games)) invalid('`games` must be an array (empty means all).');
  if (typeof source.search !== 'function') invalid('Catalog source must implement `search()`.');

  for (const field of source.secretFields ?? []) {
    if (typeof field !== 'string' || field === '')
      invalid('`secretFields` must be non-empty strings.');
  }

  return problems;
}

export function assertValidCatalogSource(source: CatalogSource): void {
  const problems = validateCatalogSource(source);
  if (problems.length > 0) {
    throw new Error(
      `Catalog source "${source.key ?? '(unnamed)'}" is invalid:\n` +
        problems.map((p) => `  - [${p.code}] ${p.message}`).join('\n'),
    );
  }
}

/** True when this source can supply ids in the given namespace. */
export function providesExternalId(source: CatalogSource, namespace: string): boolean {
  return source.key === namespace || (source.providesExternalIds ?? []).includes(namespace);
}
