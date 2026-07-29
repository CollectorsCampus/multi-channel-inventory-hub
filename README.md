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

> **Status: v0.1.0 — first release.** All five phases are built. The sync loop runs end to
> end: a sale on Shopify decrements the ledger and pushes recomputed quantities back out,
> with oversells and failures in an alert inbox, and a nightly reconciliation catching what
> the loop missed. The Shopify path — authentication, reads, both write mutations and
> signed webhook delivery — is verified against a real store, and the TCGPlayer file path
> against a real seller account.
>
> It is a `0.x` for honest reasons: MySQL and SQLite are not supported yet, no real identity
> provider has completed an OIDC login, and it has one store's worth of production evidence.
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
- **A card catalogue.** Scryfall-backed intake so items are entered by searching, not typed.
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
docker pull ghcr.io/collectorscampus/multi-channel-inventory-hub:0.1.0
```

Multi-arch (`linux/amd64`, `linux/arm64`), also tagged `0.1` and `latest`. Point
`docker-compose.yml`'s `app` service at it — replace the `build:` block with
`image: ghcr.io/collectorscampus/multi-channel-inventory-hub:0.1.0`.

Pin the exact version rather than `latest` for anything you rely on. While this is `0.x`, a
minor bump may carry breaking changes; `0.1` tracks patches within the current minor.

## Connecting Shopify

**Shopify retired legacy custom apps on 1 January 2026.** There is no permanent Admin API
token to paste in any more, and "Develop apps" is gone from the store admin. If a guide
tells you to create a custom app and copy an `shpat_` token, it predates that change.

Instead, create an app in the [Dev Dashboard](https://shopify.dev/dashboard) for the store
you own. It authenticates with the OAuth **client credentials** grant, and the hub mints
and refreshes its own 24-hour tokens.

1. Create an app, and give it these scopes — no more:

   ```
   read_products,write_products,read_inventory,write_inventory,read_locations,read_orders
   ```

   Not `write_orders`: the hub never cancels or modifies an order.

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
  down to recomputing Shopify's own HMAC over the received body.
- **TCGPlayer** — a real Level 4 seller's exports import with zero problems (1333 pricing
  rows, 219 pull-sheet rows → 236 sale events), and a file the hub generated was accepted
  through `Import To Staged` on the live account.

**Not yet:**

- **MySQL and SQLite.** The schema is proven dialect-neutral and CI validates it against all
  three, but only Postgres has a migration history. Treat them as unsupported.
- **A real identity provider.** OIDC is exercised end to end against a fake issuer with real
  RSA keys, including every forged-token case, but no Keycloak, Entra or Auth0 has completed
  a login.
- **`orders/create` parsing against a live order.** Webhook _verification_ is proven with
  real deliveries; the order payload parser is covered by tests against recorded shapes.
- **Reconciliation against a real disagreement.** The diff is tested exhaustively, but no
  live store has yet drifted and been caught.
- **Scale.** This has run against one store's catalogue, not a hundred thousand listings.

## License

[AGPL-3.0-or-later](LICENSE). You may run, modify and self-host this freely. If you offer a
modified version to others over a network, you must publish your source.
