# Working notes for Claude

Context for anyone (human or model) picking this project up. The design documents
(`TECHNICAL_DESIGN.md`, `PROJECT_OVERVIEW.md`) describe the _intent_; this file records what
was actually built, where reality diverged, and the rules that keep it coherent.

**`TECHNICAL_DESIGN.md` is authoritative — except where an ADR supersedes it.** Several
parts of it turned out to be wrong or unimplementable; those are recorded in
`docs/adr/`, not silently ignored. Read the ADRs before trusting a §-reference.

---

## Where things stand

| Phase | Scope                                                                   | Status                                |
| ----- | ----------------------------------------------------------------------- | ------------------------------------- |
| 0     | Monorepo, CI, Docker, local auth, schema + migrations                   | Done                                  |
| 1     | Inventory CRUD, allocation engine, browser/detail UI                    | Done                                  |
| 2     | Connector SDK, catalog sources, Scryfall, intake flow                   | Done                                  |
| 3     | Shopify connector, BullMQ queue, webhook ingress, channel + activity UI | Done                                  |
| 4     | TCGPlayer file-based connector                                          | Done                                  |
| 5     | Reconciliation, alerting polish, query console, OIDC, release           | **In progress** — reconciliation done |

`main` is green: **547 tests**, lint/typecheck/build clean, all four CI jobs passing.

### What Phase 4 actually shipped

`packages/connector-tcgplayer` is registered in `BUNDLED_CONNECTORS` and declares
`listing.export`, `orders.import` and `inventory.import` — a `manual` channel, with no
credentials, because there is nothing to authenticate against (ADR 0002).

- **`condition.ts`** splits and rebuilds TCGPlayer's four-in-one `Condition` string. It is
  the exact inverse of itself across the whole vocabulary, pinned by a cross-product test.
- **`formats.ts`** holds a fixed header set per file type. The old branch resolved columns
  through operator-editable aliases; that surface is gone, because it let someone point the
  quantity column at a price column and silently rewrite their own stock.
- **Core file transport** is `ChannelFilesService` plus `GET /channels/:id/export` and
  `POST /channels/:id/import?kind=orders|inventory`. Uploads arrive as a raw `text/csv`
  body — `bootstrap.ts` registers the content-type parser, and `test/boot.spec.ts` guards
  it, because Fastify answers 415 in the router before any code of ours runs.
- **The channel card** renders the round trip from declared capabilities, so any future
  file-based connector gets the UI for free.

The abandoned `phase-4-tcgplayer-wip` branch is superseded; only its CSV codec survived.

**Two things about `Sku` and the export are compromises, not designs — read before
extending:**

1. **Our model has three SKU fields, TCGPlayer packs four dimensions.** `Sku` is
   `condition` + `printing` + `language`; TCGPlayer's _edition_ ("1st Edition",
   "Unlimited") has no column. Edition and finish therefore share `printing` as a composite
   token — `HOLOFOIL`, `1ST_EDITION_HOLOFOIL`, `UNLIMITED_HOLOFOIL`. Lossless and
   reversible, but a real `edition` column would mean changing `Sku`'s natural key, which
   was too large a change to make mid-phase.
2. **`Total Quantity` vs `Add to Quantity` on _upload_ is unverified.** Both columns are
   documented below as they appear in an export; which one TCGPlayer acts on when a file is
   uploaded back is not known. The export writes the desired quantity to `Total Quantity`
   and a literal `0` to `Add to Quantity` — a no-op under the additive reading, correct
   under the absolute one. Worst case the export changes nothing; it cannot overstate
   stock. **Confirm this against a real Pro account before anyone relies on the outbound
   half.**

### Phase 5 so far: reconciliation

`apps/api/src/sync/reconcile.ts` holds the judgement as pure functions, the way
`allocation.ts` does; `reconcile.service.ts` does the I/O around them. Nightly on
`RECONCILE_CRON` (a BullMQ repeatable, no scheduler dependency) plus
`POST /channels/:id/reconcile` for on demand, which runs synchronously and
returns the report — an operator pressing a button wants an answer, not a job id.

Four decisions worth not re-deriving:

- **The comparison is against `listedQuantity`, not `desiredListedQuantity`.**
  That is the whole reason `listedQuantity` exists and is written only after a
  successful push. Comparing against the desired value would flag every
  allocation with a push in flight, which is normal. The reverse gap — a push
  that never landed — is reported separately as `pending`, and already has a
  `sync_failure` alert of its own.
- **A listing the channel does not report is `missing`, never quantity 0.** The
  SDK requires connectors to omit ids they cannot find, so an omission is "no
  answer". Reading it as zero would manufacture drift for every listing a seller
  legitimately removed on the platform.
- **Prices are not compared by default.** §6's price policy is last-write-wins,
  and platforms round, apply fees and report sale prices, so it would be a
  permanent stream of findings nobody can act on. `?comparePrices=true` opts in.
- **Auto-correction is per channel, off by default, one-directional.** It only
  re-queues a quantity push. `missing` and `inactive` are excluded because
  reactivating a listing the seller pulled would be the software overruling them,
  and `price` because the channel's value may legitimately be newer.
  `ChannelInstance.reconcileAutoCorrect` gates it.

One alert per channel, refreshed and self-clearing — and the sweep only touches
alerts it raised, because the inbound worker files `reconcile_drift` too for a
sale against an unmapped listing, which is a different fact.

Manual channels never reach any of this: they do not declare `reconcile`, so
their expected staleness cannot be mistaken for drift.

### Phase 5 so far: the query console

`apps/api/src/query-console/` is the **one** sanctioned exception to the
no-raw-SQL rule — the raw statement is the feature. Off by default, admin-only,
PostgreSQL-only, and `GET /query-console/status` is what makes the nav link
appear at all.

Three layers, and they are not equally worth anything:

1. **A separate database role** on `QUERY_CONSOLE_DATABASE_URL`, granted
   `SELECT` and nothing else. `validateEnv` refuses to boot with the console
   enabled and no separate URL, because the obvious shortcut — pointing it at
   `DATABASE_URL` — silently removes the whole protection. The exact `GRANT`
   recipe is in `.env.example`, and a test builds that role and proves it cannot
   write, so a mistake in the documentation fails CI rather than a deployment.
2. **A `READ ONLY` transaction** around every statement, so a misconfigured role
   is still refused by PostgreSQL itself. This is the layer that matters, and
   the tests demonstrate it by pointing the console at the application's own
   read-write connection and showing writes still fail.
3. **A statement shape check** in `statement.ts`, which is a courtesy that turns
   an obvious mistake into a clear message. **Not a security boundary** — it is
   documented as such in the file, because a regex over SQL is exactly the kind
   of thing someone later mistakes for one and deletes the transaction.

A writing CTE (`WITH x AS (INSERT ...)`) and `EXPLAIN ANALYZE INSERT` both sail
past any keyword filter and are refused by layer 2; both are pinned by tests.

Why this is defensible at all: the database holds no directly usable secret.
Session tokens are SHA-256 hashes, API keys argon2id, channel credentials
AES-GCM ciphertext with the key in the environment. The blast radius is business
data an admin can already read through the UI.

**Not persisted:** who ran which statement is written to the application log,
not to a table. A queryable audit trail would need its own model and retention
story, and `SyncEvent` is the wrong home — it is the log of external mutations,
and a read is neither.

### Phase 5 so far: OIDC

`apps/api/src/auth/oidc/` — generic OpenID Connect, authorization code flow with
PKCE, selected by `AUTH_PROVIDER=oidc`. No schema change was needed: Phase 0
already left `User.provider`, `User.externalId` and `@@unique([provider,
externalId])` in place.

**ID token verification is the one thing not hand-written.** It goes through
`jose` with an explicit asymmetric algorithm allow-list, the expected issuer and
audience, and a clock tolerance. Discovery, the redirect and the code exchange
are ordinary HTTP and live in the repo where they can be read; JWT signature
verification against a rotating JWKS is where hand-rolled OIDC fails silently,
so it is delegated. `jose`'s `customFetch` hook routes the JWKS through the same
injected fetch as everything else — otherwise it would be a second network seam
no test could reach, and it is the input that decides whether a token is real.

Four decisions, all confirmed with the operator rather than assumed:

- **Break-glass local login is on by default** (`OIDC_ALLOW_LOCAL_LOGIN`). This is
  self-hosted software; a mistyped redirect URI locking someone out of their own
  inventory is a worse failure than a second door. The door only admits accounts
  that already have a password, and `LocalAuthProvider` refuses any user whose
  `provider` is not `local`, so an SSO identity cannot be impersonated through it.
- **The IdP is authoritative when `OIDC_ROLE_CLAIM` is set** — the mapped role is
  reapplied on every login, so revoking a group takes effect at once. With no
  claim configured, roles are local after provisioning and are never overwritten.
- **The first identity to sign in on an empty instance becomes admin**, mirroring
  first-run local setup. Only ever fires at user count zero.
- **Users are keyed on `sub`, never email.** Addresses get reassigned between
  people, and matching on one would hand a new joiner the previous holder's access.

Two properties that are stricter than the specification, on purpose: every
discovery endpoint must share the issuer's origin (the token endpoint receives
the client secret), and `returnTo` must be a single-slash absolute path (an open
redirect on a login endpoint is how a phishing URL gets to start on the victim's
own domain).

**`jose` is ESM-only and `apps/api` compiles to CommonJS.** That works because
Node 22.12+ can `require()` an ESM module with no top-level await — which is why
`engines.node` is `>=22.12.0` rather than the `>=22.11.0` it said before. The
Dockerfile pins `node:24`.

## TCGPlayer file formats (verified against a real Pro account, 2026-07-28)

Derived from real exports. Redacted fixtures preserving every shape below live in
`packages/connector-tcgplayer/test/fixtures/` — **use those; the real exports are not in
the repo and are not needed.**

Three exports matter, and two must never be touched:

| Export                           | Use                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `MyPricing`                      | Inventory state → `inventory.import`, and the shape `listing.export` must emit |
| `PullSheet`                      | **The only line-item sales source** → `orders.import`                          |
| `OrderList`                      | Useless here — order totals only, no products                                  |
| `ShippingExport`, `PackingSlips` | **Never ingest.** Full customer names and postal addresses.                    |

**MyPricing** — header row unquoted, every value quoted, **CRLF**:

```
TCGplayer Id,Product Line,Set Name,Product Name,Title,Number,Rarity,Condition,
TCG Market Price,TCG Direct Low,TCG Low Price With Shipping,TCG Low Price,
Total Quantity,Add to Quantity,TCG Marketplace Price,Photo URL
```

**PullSheet** — header row unquoted, every value quoted, **LF** (the two exports disagree
on line endings, so the parser must handle both):

```
Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,
Main Photo URL,Set Release Date,SkuId,Order Quantity
```

Facts that are not guessable from the headers:

- **`TCGplayer Id` / `SkuId` are SKU-level**, not product-level: the same card in Near Mint
  Foil and Lightly Played Foil has two different ids. So `externalListingId` is that id
  alone — no composite key needed. Confirmed by 218 of 219 pull-sheet ids appearing in the
  pricing export, i.e. one shared id space.
- **`Order Quantity` is not a quantity.** It is `<order#>:<qty>`, pipe-separated across
  orders: `AAAA-1111-AAAA:6 | AAAA-2222-BBBB:2`. This is what makes `orders.import`
  possible at all, and it gives a stable idempotency key: `hash(order# + skuId)` —
  **deliberately excluding the quantity**, because part-shipping an order shrinks it on the
  next download and a key including it would read the same sale as a new one.
  Verified that `Quantity` equals the sum of the `:N` parts in every row; a row where that
  stops holding is reported, and the per-order pairs are trusted over the total.
- **`Condition` merges condition, edition, finish and language** into one string:
  `Near Mint Holofoil`, `Moderately Played Unlimited Holofoil`,
  `Near Mint Holofoil - Japanese`, `Unopened`. The grammar is
  `<condition>[ <edition>][ <finish>][ - <language>]`. `condition.ts` splits and rebuilds
  it; anything it does not recognise becomes an import problem naming the exact string and
  is **never guessed** — a guesser files a Japanese card as English.
- **Real data contains an empty `Condition`.** That is a distinct outcome from an
  unreadable one (`absent` vs `unrecognised`) and is not reported as a problem. An
  unreadable condition is reported but does **not** discard the row: the row's identity is
  the SKU id, and losing a real sale is worse than flagging one.
- **Prices carry 2 _or_ 4 decimal places** (`13.33`, `17.0000`). Parse without floats.
- **Quantity 0 rows are normal**, not errors — 563 of 1333 in a real export. They mean
  "priced but not stocked", and reconciliation must not read them as drift.

**Operational caveat for `orders.import`:** a pull sheet lists orders _awaiting
fulfilment_, not a sales history. Shipped orders drop off it, so an operator who ships
before uploading never records those sales. Idempotency makes re-uploading safe, but
nothing makes a _missed_ upload recoverable except inventory reconciliation.

---

## Non-negotiable rules

These exist because breaking them produces bugs that only surface on someone else's
database or someone else's marketplace account. `CONTRIBUTING.md` is the canonical list.

1. **No raw SQL in core.** ESLint blocks `$queryRaw`/`$executeRaw`. It breaks the
   MySQL/SQLite targets.
2. **Schema stays dialect-neutral.** No `Json` columns, no `enum` types — for subtler
   reasons than "SQLite can't"; see ADR 0001. Run `pnpm --filter @hub/db validate:all`
   after touching `schema.prisma`.
3. **Database identifiers are snake_case.** `@map` on any field that isn't a single
   lowercase word.
4. **Never put a nullable column in a `@@unique` meant to prevent duplicates.**
   `NULL != NULL` on all three dialects, so it silently never fires.
5. **All quantity mutations go through `InventoryService`.** Nothing else writes
   `quantityOnHand`, `reserveQuantity`, or a fixed partition.
6. **Connectors never compute quantities.** They translate; the core decides.
7. **No `import type` for anything NestJS injects.** It compiles and typechecks fine, then
   DI fails at runtime because `design:paramtypes` degrades to `Object`.
8. **Some packages are resolved at runtime, not imported.** `ValidationPipe` needs
   `class-validator`; `useStaticAssets` needs `@fastify/static`. A missing one passes every
   static check and then crash-loops the container. `apps/api/test/boot.spec.ts` guards this.

---

## Architecture decisions worth knowing

**Allocation** (`apps/api/src/inventory/allocation.ts`) is pure functions, no I/O. Two
findings the design document got wrong, both pinned by tests:

- A pooled sale can break the invariant with _no number going negative_. Repaired by
  consuming reserve first, then trimming the largest fixed partitions.
- A fixed sale **never** moves a pooled channel — on-hand and the partition fall together,
  so the pool is unchanged by construction. §6 implies otherwise.

**Concurrency** is optimistic locking on `InventoryItem.version`, not `SELECT ... FOR
UPDATE` (Prisma takes no row locks; SQLite has none). Retries use exponential backoff
**with full jitter** — without jitter, contending writers livelock. That was a real bug
found by a 20-writer test.

**Queue jobs carry _what_ changed, never the value.** The worker re-reads at execution, so
a retry landing after a newer change writes current state. It also lets a burst collapse to
one job. BullMQ rejects `:` in queue names _and_ custom job ids — §6's `push:{...}` naming
is not valid.

**`listedQuantity` means "what we believe the channel actually shows."** Only the outbound
worker writes it, after a successful push. Writing it optimistically makes reconciliation
compare our own guess against the channel and find no drift exactly when there is some.

**Catalog sources are a separate interface from connectors.** A catalog source has no
listings, no orders and no place in the allocation loop. There is deliberately no
`catalog.search` capability.

**Credentials** are AES-256-GCM with the credential `ref` bound in as additional
authenticated data — otherwise DB write access would let someone move one channel's
ciphertext onto another and authenticate to the wrong platform.

**Alerts are flags, not tallies.** One open `sync_failure` per channel, refreshed with the
latest reason. An alert per failed push floods the inbox and trains operators to ignore it.

**Uploaded files ride the webhook path.** An order import is stored as a `WebhookEvent` with
topic `file:orders` and queued; the inbound worker parses and applies it exactly as it does
a Shopify delivery. Per-sale idempotency, allocation lookup and oversell alerting already
live there, and a file-specific copy of them would be a second set of bugs. The upload
endpoint parses too, but only to answer the operator — the worker's parse is authoritative,
the same way the outbound worker re-reads its allocation.

**An inventory import writes nothing.** It reports what the platform believes against what
we believe and stamps `lastReconciledAt`. There is no policy yet for what a difference
_means_ — a lower platform quantity could be a missed sale, a manual edit, or stock never
pushed — and picking one silently would be reconciliation implemented by accident. Phase 5
owns that.

---

## Testing

- `pnpm test` runs everything. Integration suites **skip** unless `TEST_DATABASE_URL` /
  `TEST_REDIS_URL` are set — they truncate tables and obliterate queues, so only ever point
  them at throwaway instances.
- **Spec files run sequentially** (`fileParallelism: false`). Several share one database and
  truncate each other's rows in parallel, producing off-by-one flakes that vanish when run
  alone.
- **Contract suites must have teeth.** The SDK's own tests prove a connector that fabricates
  ids, uses unstable idempotency keys, or throws on malformed input _fails_ checks the
  reference implementation passes. A green suite that can't fail is worse than none.
- Connector tests run against **mocks, never live accounts**. Catalog tests use recorded
  shapes — hammering Scryfall on every CI run is how projects get blocked.

Local services used during development:

```bash
docker run -d --name hub-test-db -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub_test -p 5433:5432 postgres:17-alpine
```

```bash
docker run -d --name hub-test-redis -p 6380:6379 redis:7-alpine
```

---

## Environment notes

- **Windows / PowerShell 5.1.** No `&&` chaining. Paths contain a space (`D:\Claude Shopify
TCG Project`) — use `-LiteralPath`; some deletion commands are blocked by the sandbox.
- Node 24 via winget, pnpm via `npm -g` (corepack needs admin here).
- Git identity is set **repo-local**: `collectorscampus <nick@collectorscampus.com>`.
- Docker Desktop has wedged once (container unkillable) and a build segfaulted once
  (exit 139). Both were transient; verification fell back to running the API directly.
- The Dockerfile copies package manifests **one at a time** — a new workspace package needs
  two lines added there or the image build breaks.

---

## What has never been tested

Worth stating plainly, because the README is optimistic by nature:

- **No live Shopify store.** The connector has only ever run against a mock and a fake
  domain. HMAC verification, the GraphQL shapes and the location scoping are unproven
  against the real Admin API.
- **No live TCGPlayer account.** The formats below were read off real exports, and the
  connector is verified against redacted fixtures of them, but nothing has ever been
  _uploaded_ to TCGPlayer. The unknown that matters is which quantity column their importer
  acts on (Phase 4 above); everything inbound is exercised against the real shapes.
- **MySQL and SQLite are not supported yet.** Only the schema is proven portable; there is
  no migration history for them (ADR 0001 §4).
- **No real identity provider.** OIDC is exercised end to end against a fake issuer
  with real RSA keys — every forged-token case is a test — but no Keycloak, Entra or
  Auth0 has ever completed a login. What is unproven is the shape of real discovery
  documents and claims, not the verification logic.
- **Reconciliation has never seen a real platform disagree.** The loop is exercised
  end to end against a fake connector that reports whatever a test tells it to, and by
  hand against a running instance — but no live Shopify store has ever drifted and been
  caught. The diff is thoroughly tested; what is unproven is whether `fetchLiveState`
  returns what the Admin API actually says.
