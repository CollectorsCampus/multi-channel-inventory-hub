/**
 * @hub/connector-sdk — the published contract every channel connector implements.
 *
 * Connectors are dumb pipes. A connector translates between the core's
 * canonical operations and one platform's interface; it never decides a
 * quantity, never reads the ledger, and never resolves a conflict. All
 * allocation maths lives in the core (TECHNICAL_DESIGN.md §5).
 *
 * The contract test suite is published separately from `@hub/connector-sdk/testing`
 * so this entry point stays free of a vitest dependency.
 *
 * See docs/CONNECTOR_GUIDE.md.
 */

export * from './capabilities';
export * from './types';
export * from './connector';

/**
 * Catalog sources are a separate plugin point from connectors: they answer
 * "what product is this?" and have no listings, orders or ledger relationship.
 * The package keeps the name `connector-sdk` (§10 fixes the repository layout),
 * but it is really the plugin SDK for both contracts.
 */
export * from './catalog';

export const CONNECTOR_SDK_VERSION = '0.6.1';
