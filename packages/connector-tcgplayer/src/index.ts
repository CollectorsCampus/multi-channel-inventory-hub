/**
 * @hub/connector-tcgplayer — TCGPlayer connector.
 *
 * Phase 0 placeholder. Catalog search (usable pre-approval) lands in Phase 2;
 * OAuth, inventory push and order polling land in Phase 4, gated on the
 * TCGPlayer API application being approved (TECHNICAL_DESIGN.md §5, §11, §12).
 *
 * Because approval is an external dependency with no controllable timeline,
 * this connector is built and verified against a mock platform via the shared
 * connector contract tests rather than against the live API.
 */

export const TCGPLAYER_CONNECTOR_KEY = 'tcgplayer';
