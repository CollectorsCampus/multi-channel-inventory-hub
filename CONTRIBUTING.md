# Contributing

## Getting set up

Requires Node 22+ and pnpm 9+.

```bash
pnpm install
```

```bash
docker compose up -d postgres redis
```

Point `DATABASE_URL` at that Postgres, then:

```bash
pnpm db:migrate
```

## Before opening a pull request

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
```

CI runs exactly this, plus a Docker image build and a schema-portability check.

## Rules that are not negotiable

These exist because breaking them produces bugs that only appear on somebody else's
database or somebody else's marketplace account — the worst kind to diagnose.

**1. No raw SQL in core code.** ESLint blocks `$queryRaw`/`$executeRaw` and friends. Where
reporting genuinely needs raw SQL, put it behind a per-dialect adapter with an explicit
`eslint-disable` and a comment explaining why.

**2. Keep the schema dialect-neutral.** No dialect-specific native types. No `Json`
columns or `enum` types — see [ADR 0001](docs/adr/0001-phase-0-deviations.md) for the
reasoning, which is subtler than "SQLite can't do it". Run `pnpm --filter @hub/db validate:all`
after touching `schema.prisma`.

**3. Never put a nullable column in a `@@unique` meant to prevent duplicates.**
`NULL != NULL` in unique indexes on all three dialects, so the constraint silently never
fires. Use a non-null sentinel default instead — see `Sku.printing`.

**4. All quantity mutations go through `InventoryService`.** Nothing else may write
`quantityOnHand`, `reserveQuantity`, or a fixed allocation's `quantityAllocated`. The
allocation invariant is enforced in exactly one place, using the optimistic-locking scheme
in ADR 0001.

**5. Connectors never compute quantities.** See [the connector guide](docs/CONNECTOR_GUIDE.md).

**6. Do not use `import type` for anything NestJS injects.** In `apps/api`, providers and
`@Body()` DTOs must be value imports. A type-only import is erased at compile time, so
`emitDecoratorMetadata` writes `Object` into `design:paramtypes` and DI fails at runtime
while typechecking passes cleanly. `apps/api/test/app.module.spec.ts` guards against this.

## Commits and branches

Branch off `main`. Keep the working tree formatted — `pnpm format` is not optional, CI
checks it.
