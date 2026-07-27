/**
 * @hub/connector-sdk — the published contract every channel connector implements.
 *
 * Phase 0 ships this package as a buildable placeholder only. The `Connector`
 * interface, `Capability` union, `Ctx`/credential plumbing, and the shared
 * contract test suite are Phase 2 deliverables (TECHNICAL_DESIGN.md §5, §11).
 *
 * Do not add core quantity logic here. Connectors are dumb pipes: they
 * translate between the core's canonical operations and a platform's API, and
 * never decide quantities themselves.
 */

export const CONNECTOR_SDK_VERSION = '0.0.0';
