# Multi-Channel Inventory Hub

Self-hostable, open-source inventory sync for sellers who list the same stock in more than
one place.

A central ledger is the single source of truth. Sales channels — Shopify and TCGPlayer
first — are pluggable **connectors** that stock is allocated out to. When something sells
anywhere, the ledger decrements and updated quantities are pushed to every other affected
channel, so the same card is not sold twice.

> **TCGPlayer is no longer issuing API keys.** Their developer programme is closed to new
> applicants, so the TCGPlayer connector is file-based (CSV export/import) rather than
> continuously synced, and sellers holding a legacy key get the API path automatically.
> Shopify is the only continuous-sync channel in v1. See
> [ADR 0002](docs/adr/0002-tcgplayer-without-an-api.md).

> **Status: v0.3.0.** All five phases are built and the sync loop runs end to end: a sale on
> Shopify decrements the ledger and pushes recomputed quantities back out, with oversells and
> failures in an alert inbox, and a nightly reconciliation catching what the loop missed. The
> Shopify path — authentication, reads, both write mutations, signed webhook delivery and a
> real order — is verified against a live store, and the TCGPlayer file path against a real
> seller account.
>
> 0.2.0 added what an operator with an **existing** storefront needs: a `/match` screen that
> reads what a channel already sells and proposes links to the catalogue. 0.3.0 covers the
> other direction — putting a card the store does **not** carry onto the storefront, with its
> conditions as variants, the store's own tags and custom fields, and an identifier that lets
> a rebuilt hub re-derive every link from the platform.
>
> It is a `0.x` for honest reasons: MySQL and SQLite are not supported yet, only one identity
> provider has ever completed a login, and it has one store's worth of production evidence.
> See [What is proven](#what-is-proven) before trusting it with stock you cannot recount.

## Why

Commercial multi-channel tools charge thousands per year and lock you to their platform.
This connects using _your_ seller credentials, runs on _your_ hardware, and stores data in
_your_ database. No middleman sits between you and your money.

## What it does

- **One ledger, many channels.** Allocate stock per channel as an exclusive slice
  (`fixed`) or a shared pool (`pooled`), mixing both on the same SKU.
- **Sales fan out automatically.** A Shopify sale arrives by webhook, decrements the
  ledger, and pushes recomputed quantities to every other affected channel.
- **Reconciliation.** A nightly sweep compares what each channel actually shows against
  what the hub believes, reports the difference, and — only if you opt in, per channel —
  re-pushes quantities. The ledger is never rewritten from a channel.
- **An alert inbox.** Oversells, failed pushes and drift, ordered by urgency. Conditions
  that persist stay one alert rather than one per occurrence, so the inbox is worth reading.
- **Match an existing storefront.** Read what a channel already sells and get proposed links
  to the catalogue, set at a time, each with its evidence ranked. Nothing is ever applied on
  its own, and a tie is reported as ambiguous rather than resolved by picking one.
- **Create listings a channel does not have.** Put selected ledger items onto the storefront
  as drafts, conditions as variants, carrying the store's own tags and custom fields — never
  values the hub invented.
- **A card catalogue.** Scryfall and TCGPlayer-derived sources, searchable at intake, and
  ingestible in bulk into a local catalogue that works with the network down.
- **Read-only SQL console.** Off by default, admin-only, and behind both a `SELECT`-only
  database role and a `READ ONLY` transaction.
- **Local accounts or SSO.** Username/password out of the box, or any OpenID Connect
  provider with PKCE, with break-glass local login retained by default.

## Quick start

```bash
cp .env.example .env
```

Generate the two required secrets and paste them into `.env`:

```bash
openssl rand -base64 32
```

Both are required and the app refuses to start without them. `CREDENTIAL_MASTER_KEY`
encrypts your channel credentials at rest — **back it up**, because losing it means
re-entering every channel's secrets.

Then:

```bash
docker compose up -d
```

This builds the image from source the first time, which takes a few minutes; afterwards it
starts in seconds. It brings up the app, Postgres and Redis, and applies migrations on boot.

Open <http://localhost:3000>. The first visit prompts you to create an admin account — no
default credentials ship with the image.

### Using the published image instead

To skip the build, pull the released image rather than compiling from source:

```bash
docker pull ghcr.io/collectorscampus/multi-channel-inventory-hub:0.3.0
```

Multi-arch (`linux/amd64`, `linux/arm64`), also tagged `0.3` and `latest`. Point
`docker-compose.yml`'s `app` service at it — replace the `build:` block with
`image: ghcr.io/collectorscampus/multi-channel-inventory-hub:0.3.0`.

Pin the exact version rather than `latest` for anything you rely on. While this is `0.x`, a
minor bump may carry breaking changes; `0.3` tracks patches within the current minor.

## Connecting Shopify

**Shopify retired legacy custom apps on 1 January 2026.** There is no permanent Admin API
token to paste in any more, and "Develop apps" is gone from the store admin. If a guide
tells you to create a custom app and copy an `shpat_` token, it predates that change.

Instead, create an app in the [Dev Dashboard](https://shopify.dev/dashboard) for the store
you own. It authenticates with the OAuth **client credentials** grant, and the hub mints
and refreshes its own 24-hour tokens.

1. Create an app, and give it these scopes — no more:

   ```
   read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_metaobjects
   ```

   Not `write_orders`: the hub never cancels or modifies an order.

   `read_metaobjects` is needed only to read back the custom fields your store already
   models, when creating products. **Add it now if you might want that**: without it
   Shopify answers `null` with no error, so a store that has defined nothing and an app
   that may not look are indistinguishable — and adding a scope later needs the app
   uninstalled and reinstalled, not merely released again.

2. Release a version, then — on the app's **Home** page — scroll down and use
   **Install app**. Releasing is not installing, and skipping this is the single most
   common setup failure: authentication fails with _"The application is not installed on
   this shop"_, which reads like a credentials problem and is not one.

3. In the hub, add a Shopify channel with the **client ID** and **client secret** from the
   app, your shop domain, and the location to sync.

Two things worth getting right:

- **Prefer the permanent `.myshopify.com` domain** (`abc123-45.myshopify.com`) over a
  vanity one. Renaming the store breaks the alias but never the permanent domain.
- **`webhookSecret` is optional.** Shopify signs an app's webhooks with that app's client
  secret, so webhook verification works with no extra configuration. Set it only for a
  subscription you created by hand with a secret of its own.

Webhooks need the hub reachable from the internet. For a local trial, a tunnel
(`cloudflared tunnel --url http://localhost:3000`) is enough to receive real deliveries.

## Local development

Requires Node 22+ and pnpm 9+.

```bash
pnpm install
```

Start Postgres and Redis only, leaving the app to run on the host:

```bash
docker compose up -d postgres redis
```

Point `DATABASE_URL` at it, then set up the database:

```bash
pnpm db:migrate
```

Run the API (`:3000`) and the SPA dev server (`:5173`, proxying `/api`) together:

```bash
pnpm dev
```

Useful scripts:

| Command                     | What it does                         |
| --------------------------- | ------------------------------------ |
| `pnpm db:migrate`           | Create and apply a migration         |
| `pnpm db:seed`              | Load development sample data         |
| `pnpm db:studio`            | Browse the database in Prisma Studio |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                    |
| `pnpm typecheck`            | Typecheck every workspace project    |
| `pnpm test`                 | Run all tests                        |

## Architecture

```
apps/api                 NestJS (Fastify) — REST + OpenAPI, serves the built SPA
apps/web                 React + Vite single-page app
packages/db              Prisma schema, migrations, seed
packages/connector-sdk   The contract every connector implements
packages/connector-*     Shopify and TCGPlayer connectors
```

Three rules hold the design together:

1. **Webhook ingress does no work inline.** Verify the signature, persist the raw event,
   enqueue, return 200. Everything else happens in a queue worker.
2. **Connectors are dumb pipes.** A connector translates between the core's canonical
   operations and a platform's API. It never decides quantities — the core owns all
   quantity math.
3. **The ledger is never silently rewritten from a channel.** Reconciliation reports drift
   and alerts a human; auto-correction is opt-in and only ever pushes _our_ numbers out.

### Allocation modes

Each SKU can be allocated to a channel in one of two modes, and modes can mix on the same
SKU:

- **`fixed`** — the channel owns an exclusive slice. 10 on hand → 6 to Shopify, 3 to
  TCGPlayer, 1 held back. A sale decrements only that slice.
- **`pooled`** — the channel mirrors shared stock, with an optional cap. Listed quantity is
  _computed_, never stored as truth:

  ```
  pool         = quantityOnHand − Σ(fixed partitions) − reserveQuantity
  listed(chan) = min(chan.maxQuantity ?? ∞, pool)
  ```

  10 on hand, Shopify capped at 5, TCGPlayer uncapped → Shopify lists 5, TCGPlayer lists 10. Pooled mode intentionally exposes the same physical units on several channels, so a
  sale on any of them fans out a recomputed quantity to all the others.

The invariant `quantityOnHand ≥ Σ(fixed) + reserveQuantity ≥ 0` is enforced in a single
`InventoryService` using optimistic concurrency, so two channels cannot both claim the
last unit.

## Database support

Postgres is the reference database. The schema is deliberately free of dialect-specific
constructs so MySQL/MariaDB and SQLite can be supported through the same Prisma schema, and
CI proves the schema validates against all three.

> **Only Postgres has a migration history today.** Prisma cannot share one migration history
> across providers, so the per-provider mechanism — and the full 3-DB test matrix — is still
> to come. Treat MySQL and SQLite as not yet supported: the schema will validate, and you
> will have no way to migrate it.

Contributor rules that keep this true:

- No raw SQL in core code (ESLint enforces this). Where reporting genuinely needs it, put
  it behind a per-dialect adapter.
- No dialect-specific native types, and never query _into_ a JSON column.

## Roadmap

| Phase | Scope                                                                                         | Status   |
| ----- | --------------------------------------------------------------------------------------------- | -------- |
| 0     | Monorepo, CI, Docker, local auth, schema + migrations                                         | **Done** |
| 1     | Inventory CRUD, allocation invariants, browser/detail UI                                      | **Done** |
| 2     | Connector SDK (incl. file-based channels), Scryfall catalog, intake flow                      | **Done** |
| 3     | Shopify connector (push, then webhooks), sync activity UI                                     | **Done** |
| 4     | TCGPlayer connector — _file-based, see [ADR 0002](docs/adr/0002-tcgplayer-without-an-api.md)_ | **Done** |
| 5     | Reconciliation, alerting, query console, OIDC, public release                                 | **Done** |

Next, roughly in order of how much they would change: per-provider migrations so MySQL and
SQLite become real, TCGPlayer quantity sync (their CSV expresses only deltas, so this needs
per-allocation tracking of what has already been sent), and distinguishing an
authentication failure from a transient one so a wrong secret reads differently from a
platform hiccup.

## What is proven

Self-hosted inventory software is only worth what its worst failure costs, so this is
specific about which parts have met reality.

**Verified against live accounts:**

- **Shopify** — the client-credentials exchange, the `2026-07` Admin API, reading live
  inventory with location scoping, and both write mutations (quantity and price) written
  and read back. Webhook delivery is confirmed with real signed deliveries from a store,
  down to recomputing Shopify's own HMAC over the received body — including a real
  `orders/create`, which decremented the ledger and raised an oversell alert.
- **TCGPlayer** — a real Level 4 seller's exports import with zero problems (1333 pricing
  rows, 219 pull-sheet rows → 236 sale events), and a file the hub generated was accepted
  through `Import To Staged` on the live account.
- **Matching and creation, on a live storefront.** 139 listings matched and linked, then
  re-stamped with the hub's own SKU codes and read back with zero mismatches. Products have
  been created on the real store — single- and multi-variant, with tags, custom fields and
  the product category those fields require — and their stock arrived by the ordinary push
  path rather than a special one.
- **Reconciliation against a real disagreement.** A live sweep checked 139 listings and
  caught 23 genuine quantity drifts.
- **One identity provider.** Google has completed an OIDC login, provisioning a user keyed on
  its `sub`.

**Not yet:**

- **MySQL and SQLite.** The schema is proven dialect-neutral and CI validates it against all
  three, but only Postgres has a migration history. Treat them as unsupported.
- **Role mapping from a provider.** Google issues no group or role claims, so `OIDC_ROLE_CLAIM`
  and `OIDC_ROLE_MAP` have only ever been exercised against a fake issuer. Keycloak or Entra
  would close this.
- **Reconciliation auto-correction.** Drift has been caught live, but the opt-in re-push has
  never run against a real store.
- **Catalogue-scale ingest.** 27 sets have been ingested; no full game has (Magic alone is 453
  set files).
- **Scale.** This has run against one store's catalogue, not a hundred thousand listings.

## How this was built

**Most of this code was written by Claude** — Anthropic's Opus models — working with a single
human operator. Every commit records it in a `Co-Authored-By` trailer, so the history has
always said so; this section just says it somewhere you do not have to run `git log` to find.

The division of labour is worth being precise about, because "AI-written" covers a wide range.
The architecture, the decisions about what to accept or reject, and every verification against
a live marketplace account were the operator's. Model output that could not be demonstrated
against a real Shopify store or a real seller's export did not get merged — which is why
[What is proven](#what-is-proven) is a section in this README rather than an afterthought, and
why several of this project's sharpest findings are recorded as things the design got wrong.

[CLAUDE.md](CLAUDE.md) is the working notes for that process. It is unusually long and
unusually specific about _why_ things are as they are, including the mistakes. That is
deliberate: it is the difference between a codebase a model can safely change and one it will
confidently break.

## License

[AGPL-3.0-or-later](LICENSE). You may run, modify and self-host this freely. If you offer a
modified version to others over a network, you must publish your source.

The licence covers the source. It does not grant rights in any third-party trademark, and the
trading-card properties this software integrates with — Pokémon, Magic: The Gathering, One
Piece, Lorcana and the rest — are the marks of their respective owners. They are named here
and in the code only to describe what the software interoperates with, which is ordinary
descriptive use. Do not read that as affiliation or endorsement, and take care not to imply
either in anything you build on top.
