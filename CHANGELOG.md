# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org):
while it is `0.x`, a minor bump may contain breaking changes, and those are called out here.

## [0.1.0] — 2026-07-29

First release. All five delivery phases are built, and the Shopify and TCGPlayer paths are
verified against real accounts rather than only against mocks.

### Inventory

- A central ledger with `fixed` (exclusive slice) and `pooled` (shared, optionally capped)
  allocation per channel, mixable on the same SKU. Listed quantity for a pooled channel is
  computed, never stored as truth.
- The invariant `quantityOnHand ≥ Σ(fixed) + reserveQuantity ≥ 0` is enforced in a single
  `InventoryService` under optimistic concurrency, so two channels cannot both claim the
  last unit. Retries use exponential backoff with full jitter — without jitter, contending
  writers livelock.
- Scryfall-backed catalogue search and an intake flow.

### Channels

- **Shopify** — continuous sync: push, quantity, price, delist, order webhooks and live
  state for reconciliation. Authenticates with the OAuth client-credentials grant against
  Admin API `2026-07`.
- **TCGPlayer** — file-based (CSV), because their developer programme is closed to new
  applicants. See [ADR 0002](docs/adr/0002-tcgplayer-without-an-api.md). Imports pricing
  and pull-sheet exports; exports a price file that is safe to re-upload.
- A connector SDK with contract tests that a conforming connector must pass, doubling as
  the specification for community connectors.

### Sync

- Webhook ingress verifies the signature, persists the raw event and enqueues — no work
  inline. Redeliveries are deduplicated by a hash of the body.
- BullMQ workers carry _what_ changed, never the value, so a retry landing after a newer
  change writes current state and a burst collapses to one job.
- Nightly reconciliation plus on-demand `POST /channels/:id/reconcile`. Auto-correction is
  per channel, off by default, and only ever pushes the hub's numbers outward.
- An alert inbox ordered by urgency. Persistent conditions are one refreshed flag with an
  occurrence count rather than one row per event.

### Operations

- Single multi-arch (amd64/arm64) image; `docker compose up -d` brings up app, Postgres and
  Redis, applying migrations on boot.
- Local accounts, or any OpenID Connect provider (authorization code + PKCE). ID token
  verification is delegated to `jose` with an explicit algorithm allow-list. Break-glass
  local login stays enabled by default so a mistyped redirect URI cannot lock you out.
- RBAC: `admin`, `editor`, `viewer`, enforced by guards on every route.
- Channel credentials are AES-256-GCM encrypted with the credential ref bound in as
  additional authenticated data, so ciphertext cannot be moved between channels.
- Optional read-only SQL console: off by default, admin-only, Postgres-only, behind both a
  `SELECT`-only role and a `READ ONLY` transaction.

### Known limitations

- **MySQL and SQLite are not supported.** The schema is dialect-neutral and CI validates it
  against all three, but only Postgres has a migration history.
- **No real identity provider has completed an OIDC login.** The flow is tested end to end
  against a fake issuer with real RSA keys, including forged-token cases.
- **TCGPlayer quantity sync does not exist.** Their CSV can express a quantity delta but
  never an absolute, and a delta is not safe to re-upload, so the export carries price only
  and quantity drift is reported instead.
- **A wrong credential is not distinguishable from a transient failure** in the alert
  inbox; both surface as `sync_failure`.

[0.1.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.0
