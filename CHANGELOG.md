# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org):
while it is `0.x`, a minor bump may contain breaking changes, and those are called out here.

## [0.1.1] — 2026-07-29

A dependency-only security release. It clears every advisory that was present in the 0.1.0
image, and changes no behaviour.

**None of these was reachable in 0.1.0**, as far as could be determined — see below. If you
are running 0.1.0 you should still upgrade, but you are not being asked to treat it as an
incident.

### Security

The 18 alerts are nine distinct advisories. Four of them affect packages that are in the
runtime image:

| Package           | Severity | Issue                                      | 0.1.0 | 0.1.1  |
| ----------------- | -------- | ------------------------------------------ | ----- | ------ |
| `@fastify/static` | high     | Route guard bypass via path traversal      | 9.3.0 | 10.1.2 |
| `@fastify/static` | medium   | Authorization bypass, non-canonical paths  | 9.3.0 | 10.1.2 |
| `find-my-way`     | high     | HTTP/2 denial of service                   | 9.6.0 | 9.7.0  |
| `js-yaml`         | high     | Exponential parse time → denial of service | 5.2.1 | 5.2.2  |

Each states a precondition, and none of them held. The `@fastify/static` high needs a route
guard or middleware in front of the files being served — its own advisory gives the
workaround as "do not use route-based middlewares or guards to protect files served by
`@fastify/static`", which is a description of what this application already did; the SPA
bundle is public by design and nothing guards it. The medium needs `allowedPath`, which is
never passed. `find-my-way`'s needs a Node HTTP/2 server, and there is none. `js-yaml`'s
needs `load()` or `loadAll()` on untrusted input, and the only caller in the tree is
`@nestjs/swagger`, which uses `dump()`.

Checked as well as reasoned about: eight attempts to escape the served directory and ten
non-canonical spellings of a guarded route behave identically on 9.3.0 and 10.1.2, with no
file outside the web root readable and no guard bypassed on either.

The remaining five advisories — three `vite`, one `esbuild`, and one `vitest` critical (the
Vitest UI server can read and execute arbitrary files, reported against eight manifests) —
are build- and test-time only. The runtime stage of the image installs with `--prod`, so none
of the three packages is in it. All five are resolved by moving to vitest 3.2.6, which brings
vite 6.4.3 with it.

### Changed

- `@fastify/static` to `^10.1.2`. This leaves an unmet peer dependency:
  `@nestjs/platform-fastify` 11.1.28 asks for `^8 || ^9` and no 11.x accepts `^10`. It is a
  warning rather than a failure, and static asset serving is now covered by a test that
  fetches the real bundle, because `useStaticAssets` resolves the plugin at runtime where no
  static check reaches it.
- `find-my-way` and the `js-yaml` 5.x line are pinned through `pnpm.overrides`, because
  `@nestjs/platform-fastify` and `@nestjs/swagger` depend on the vulnerable versions
  **exactly** and both parents are already current. Remove the overrides once they catch up.
- `vitest` to `^3.2.6` across the workspace, including the connector SDK's optional peer
  range.

### Fixed

- `prettier --check .` no longer checks `pnpm-lock.yaml`. There was no `.prettierignore`, so
  a generated file was being style-checked; the committed lockfile satisfied Prettier by
  luck, and anything that regenerated it failed CI on a file no human wrote.

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

[0.1.1]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.1
[0.1.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.0
