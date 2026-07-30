# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org):
while it is `0.x`, a minor bump may contain breaking changes, and those are called out here.

## [0.2.0] — 2026-07-30

The release that makes an **existing storefront usable**. Until now the only route from a
populated Shopify store into the ledger was reading a variant id out of the admin and
typing it onto an allocation, one item at a time — and a bug meant even that was
impossible. Adds a catalogue source covering far more than Magic, and fixes a container
defect present in every published image so far.

### Fixed

- **The published 0.1.0 and 0.1.1 images cannot start without reaching npmjs.org.** The
  entrypoint ran migrations through `pnpm`, which is not in the runtime image — the stage
  inherits corepack's shim but none of the pnpm the build stages downloaded, so corepack
  fetched it from the public registry at **every container start**. It fails as a hang, not
  an error: the container sits in `starting`, goes unhealthy and never serves a request,
  with one "Corepack is about to download" line as the only clue. An air-gapped or
  egress-filtered host could never have started either image. The CLI is now invoked
  through its own bin symlink. **If you run 0.1.x behind a proxy or firewall, this is the
  upgrade that matters.**
- **`ChannelAllocation.externalListingId` could not be set by anything.** Its only writer
  was the outbound worker, from `pushListing`'s result — and Shopify's `pushListing`
  refuses to run without one. For an operator with an existing storefront the field could
  never be populated and every push failed forever. `AllocationWrite` now carries it, where
  absent means "leave alone" and explicit null detaches a link without destroying the
  allocation.
- **A correctly configured Shopify channel was told it was not connected.** A channel with
  only `clientSecret` was labelled "still needs: webhookSecret" permanently and in error
  styling, sending operators to hunt in the Dev Dashboard for a credential Shopify does not
  issue. Shopify signs an app's webhooks with its client secret, and that fallback is the
  proven path.
- **A second listing could silently steal another's link.** Confirming a match for a
  listing that resolved to an inventory item the channel already drove _moved_ the existing
  allocation instead of adding one, silently detaching the first listing while still
  reporting it as linked. Now refused, naming the listing that already holds the item.

### Added

- **Match proposals** — a `/match` screen that reads what a channel already sells and
  proposes links to the catalogue, set at a time. Evidence is ranked and every proposal
  carries its reason: an exact platform id or barcode is `certain`, an embedded id or a
  name-plus-set agreement is `probable`, a bare name is `possible`. **Nothing is ever
  applied**; a tie is reported as ambiguous with both candidates listed, never resolved by
  picking one. Only `certain` is offered for bulk acceptance.
- **`listing.enumerate`** capability and a Shopify implementation, for asking a channel
  what it is selling that the hub has never heard of. Distinct from `reconcile`, which can
  only answer questions about ids already held. It deliberately does not affect `syncMode`.
- **`listing.sku`** capability, writing the catalogue id into the channel's own seller-SKU
  field so a rebuilt hub can re-derive every link from the platform. **Opt-in, off by
  default, and destructive** where that field is already in use — it overwrites, the UI
  says so at the point of decision, and requesting it on a connector that cannot do it is
  an error rather than a silent no-op.
- **`packages/catalog-tcgcsv`** — TCGPlayer's product catalogue via tcgcsv.com, covering
  the 90 categories it publishes. Scryfall covers Magic and nothing else; a real card-shop
  inventory spans One Piece, Lorcana, Flesh & Blood, Union Arena, Gundam and sealed
  supplies. Marked a prototype: it fetches set files on demand rather than ingesting in
  bulk, and refuses an un-narrowed search instead of walking the catalogue.
- **`Connector.optionalSecretFields`**, so a connector can say a credential is only needed
  for the unusual case. Additive — unmarked fields stay required.

### Notes

- No schema changes: the four migrations are unchanged since 0.1.0, so upgrading applies
  nothing.
- Prices from tcgcsv are per product and printing, **never per condition** — it does not
  publish the SKU tier. Treat them as a market reference, not a price feed for listings.
- Nothing in this release writes to a marketplace on its own. Matching creates links and
  credits no stock; the SKU write is the one outbound call and is off unless asked for.

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

[0.2.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.2.0
[0.1.1]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.1
[0.1.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.0
