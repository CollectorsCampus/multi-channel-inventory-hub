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

export const CONNECTOR_SDK_VERSION = '0.1.0';
