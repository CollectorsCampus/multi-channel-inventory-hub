# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org):
while it is `0.x`, a minor bump may contain breaking changes, and those are called out here.

## [0.3.0] — 2026-08-02

The release that lets the hub **put a card on a storefront the store does not carry yet**.
0.2.0 could link the hub to listings that already existed; until now, a card the shop had
never sold had to be created by hand in the Shopify admin before anything here could touch
it. That path is now built end to end and has been run against a real store — selection,
variant grouping, an identifier that survives a rebuild, the store's own tags and custom
fields, and the product category those fields turn out to require.

Also: the local catalogue became real rather than a fetch-on-demand prototype, a real
identity provider signed a user in for the first time, and the UI got its first session of
actual use, which found five defects that reading the markup never would.

### Added

- **Listing creation.** `POST /channels/:id/listings` and a `/list` screen: pick ledger
  items the channel does not carry and create them there. **Selected, never automatic** — a
  1,333-row import must not become 1,333 storefront products, so this is reachable from
  nothing else, has no "select all", and a run over 50 items is refused rather than
  truncated. Products are created as **drafts**; creation sets no quantity, so stock still
  arrives by the ordinary push path and there is exactly one route from the ledger to a
  platform's numbers. A second condition of a card already listed becomes a **variant** of
  it, grouped by catalogue item.
- **`listing.create`** capability and a Shopify implementation. Distinct from `listing.push`,
  which syncs a listing that exists and carries no title, image or vendor with which to
  invent one; here the content is an input the operator supplies. Idempotent on the SKU, so a
  failure after the platform call is recoverable rather than a duplicate product.
- **A composite hub SKU code**, and a `hub-sku` match reason ranked `certain`.
  `tcgcsv:662182:NM:1ST_EDITION_HOLOFOIL:EN` — source, id, condition, printing, language —
  written into the channel's seller-SKU field. 0.2.0 wrote a bare product id there, which is
  right for sealed product and wrong for singles: a card in Near Mint and the same card
  Damaged share it, so an exact-match test would have equated them. One format for both,
  parsed strictly because it is read back off other people's listings.
- **`listing.tags`** and **`listing.metafields`** capabilities, so a created product carries
  the store's own vocabulary. Neither value is ever derived: catalogue names are not a
  store's tags (`Pokemon` against `Pokémon`, `Magic` against `Magic: The Gathering`), and on
  Shopify a custom field's value is a metaobject reference that means nothing outside that
  one shop. The operator picks; the hub applies verbatim. A field the connector cannot read
  is reported as **unavailable with a reason** rather than as an empty list, because a
  missing scope and a store with no entries otherwise look identical.
- **Bulk catalogue ingest**, and a local catalogue that is read first. `listSets` and
  `fetchSet` are new optional `CatalogSource` methods — declared together or not at all —
  with `GET /catalog/local/sets`, `GET /catalog/local/search` and a `/catalog` screen for
  browsing and running an ingest. Matching now draws candidates from the local catalogue
  where a set has been ingested and falls back to the source where it has not, which is
  worth most exactly where a remote source is least willing to help: a proposal run needs a
  whole set at once. Prices are deliberately **not** stored — identity is durable, prices are
  not.
- **`OIDC_ALLOWED_ENDPOINT_ORIGINS`**, naming extra origins an issuer's endpoints may live
  on. Empty by default and most providers need it empty; Google needs it because its token
  and JWKS endpoints are not on `accounts.google.com`.
- Inventory browsing gained **rows per page**, a **channel filter** including "on no
  channel" — the question behind "what have I not listed yet" — a **game filter** with
  counts from what is actually held, and optional card art.

### Fixed

- **A `name-partial` tie could swamp a whole set.** Containment fires in either direction, so
  a card literally named "Winterspell" was contained by every sealed listing in the
  Winterspell set and tied with the correct product on all of them — every proposal came back
  ambiguous. Candidates now carry how much of the name matched and sort by it. This is not a
  loosening of the never-resolve-a-tie rule: names of equal length still tie exactly, so two
  reprints behave as before.
- **Creating a product with custom fields failed with a message naming neither the field nor
  the cause.** Almost every metafield definition on a real store is _conditional_ — restricted
  to a product category — and a newly created product has none, so it satisfies no constraint
  at all. Definitions now report the categories they require, creation carries the answer, and
  the screen only asks when the chosen fields do not agree on one.
- **A form laid its controls out one per line.** A bare `form { flex-direction: column }` was
  overriding the shared filter bar, so identical markup in a `<form>` and a `<div>` looked
  unrelated for no visible reason.
- **Two-line table cells ran together** — "151 Booster BundleSV: Scarlet & Violet 151" — on the
  match, catalogue and listing screens. They had only ever stacked by accident, inside a
  container that happened to be a flex column.
- **The intake screen's Game field never rendered**, so tcgcsv — which refuses to search
  without a game — could not be given one, and every intake search reported it unavailable.
- **A drifted CSRF cookie was unrecoverable.** It was issued once at login, so a browser
  holding one from an earlier session failed every mutation with 403 while every read
  succeeded. `/auth/me` now re-issues it, so a reload repairs it.
- **The item detail page never said what the item was**, returning allocations and quantities
  and no identity.

### Changed

- `zod` to 4. Its single consumer is the boot-time config validator, which had no tests at
  all; those were written first, against the old version, then the upgrade ran. Three
  environment variables are booleans derived from strings and two of them fail _towards less
  safety_ if that coercion degrades.
- OIDC endpoint pinning is now an allow-list rather than an absolute same-origin rule. The
  property that mattered survives — the operator decides which hosts may receive the client
  secret, not the discovery document.

### Notes

- **No schema changes.** The four migrations are unchanged since 0.1.0, so upgrading applies
  nothing.
- **The SKU write is still opt-in and still overwrites.** If you used 0.2.0's `listing.sku`,
  those listings carry a bare product id; re-running a confirmation with the option set
  replaces them with the composite code. Back up the field first — it may mean something to
  its owner.
- **`read_metaobjects` is a new Shopify scope**, needed only for `listing.metafields`. Without
  it Shopify answers `null` with no error, which is why an unreadable field reports why rather
  than looking empty. Granting a new scope needs the app **reinstalled**, not merely released.

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

[0.3.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.3.0
[0.2.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.2.0
[0.1.1]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.1
[0.1.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.0
