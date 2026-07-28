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

> **Status: Phase 3 in progress.** The ledger, allocation engine, inventory UI, connector
> SDK and catalog intake all work end to end. The Shopify connector exists and passes the
> contract suite, but the job queue and webhook ingress that drive it do not — so nothing
> syncs outward yet. See [Roadmap](#roadmap).

## Why

Commercial multi-channel tools charge thousands per year and lock you to their platform.
This connects using _your_ seller credentials, runs on _your_ hardware, and stores data in
_your_ database. No middleman sits between you and your money.

## Quick start

```bash
cp .env.example .env
```

Generate the two required secrets and paste them into `.env`:

```bash
openssl rand -base64 32
```

Then:

```bash
docker compose up -d
```

Open <http://localhost:3000>. The first visit prompts you to create an admin account — no
default credentials ship with the image.

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

> **Phase 0 caveat:** only Postgres has a migration history today. Prisma cannot share one
> migration history across providers, so the per-provider mechanism — and the full 3-DB
> test matrix — is still to come. Treat MySQL and SQLite as not yet supported.

Contributor rules that keep this true:

- No raw SQL in core code (ESLint enforces this). Where reporting genuinely needs it, put
  it behind a per-dialect adapter.
- No dialect-specific native types, and never query _into_ a JSON column.

## Roadmap

| Phase | Scope                                                                                         | Status      |
| ----- | --------------------------------------------------------------------------------------------- | ----------- |
| 0     | Monorepo, CI, Docker, local auth, schema + migrations                                         | **Done**    |
| 1     | Inventory CRUD, allocation invariants, browser/detail UI                                      | **Done**    |
| 2     | Connector SDK (incl. file-based channels), Scryfall catalog, intake flow                      | **Done**    |
| 3     | Shopify connector (push, then webhooks), sync activity UI                                     | In progress |
| 4     | TCGPlayer connector — _file-based, see [ADR 0002](docs/adr/0002-tcgplayer-without-an-api.md)_ |             |
| 5     | Reconciliation, alerting, query console, OIDC, public release                                 |             |

## License

[AGPL-3.0-or-later](LICENSE). You may run, modify and self-host this freely. If you offer a
modified version to others over a network, you must publish your source.
