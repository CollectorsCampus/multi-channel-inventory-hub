# ADR 0001 — Phase 0 deviations from TECHNICAL_DESIGN.md

- **Status:** Accepted
- **Date:** 2026-07-27
- **Context:** Scaffolding Phase 0 surfaced four places where the design document is
  self-contradictory, not implementable as written, or silent on a decision that had to be
  made before the schema could be committed.

---

## 1. Optimistic locking instead of `SELECT ... FOR UPDATE`

§4 states that quantity mutations use "`SELECT ... FOR UPDATE` semantics via Prisma
interactive transactions."

Prisma interactive transactions do not take row locks. They open a transaction at the
database's default isolation level and nothing more. Obtaining real `FOR UPDATE` semantics
requires `$queryRaw`, which §3 forbids in core code — and SQLite has no row-level locking
at all, so the approach cannot be portable by construction.

**Decision.** `InventoryItem` carries a `version Int @default(0)` token. `InventoryService`
reads the row, computes the new state, and writes via
`updateMany({ where: { id, version }, data: { ..., version: version + 1 } })`. A zero-row
result means another transaction won the race; the operation retries with fresh state.

**Consequences.** Portable across all three dialects with no raw SQL. Costs a retry loop
under contention, which is acceptable — contention here means two sales of the same SKU
landing within milliseconds. §4's claim that "the service layer is the portable guarantee"
remains true; only the mechanism changes.

---

## 2. `String` columns instead of `Json` and `enum`

The original justification drafted for this was **wrong** and is recorded here so it is not
re-litigated: Prisma 6.19+ _does_ support both `Json` columns and `enum` types on SQLite.
Verified directly — `prisma migrate diff` emits `JSONB` for a Json field and `TEXT` for an
enum under `provider = "sqlite"`.

**Decision.** Use `String` anyway, for different and narrower reasons:

- **Json:** null semantics diverge across dialects. The `Prisma.DbNull` vs
  `Prisma.JsonNull` distinction is Postgres-only, so identical application code behaves
  differently depending on the deployment's database — precisely the class of bug the
  portability rules exist to prevent. §3 already forbids querying into these columns, so
  the ORM's Json affordances buy us nothing we would use.
- **enum:** growing a native enum is a data-rewriting migration. Postgres requires
  `ALTER TYPE`; a MySQL `ENUM` change can rewrite the whole table. The value sets most
  likely to grow (`status`, `kind`, `outcome`, `reason`) would churn migrations for what is
  effectively a lookup list.

**Consequences.** The database no longer constrains these columns, so `packages/db/src/enums.ts`
is the single source of truth and every write path must validate through its guards.
`packages/db/src/json.ts` is the only sanctioned encode/decode boundary. This is a real
loss of safety, accepted deliberately.

---

## 3. The cross-table invariant cannot be a CHECK constraint

§4 says "A CHECK constraint backs this up on databases that support it."

The invariant is `quantityOnHand ≥ Σ(fixed quantityAllocated) + reserveQuantity ≥ 0`. The
sum ranges over rows in `channel_allocations` while the compared values live on
`inventory_items`. No CHECK constraint can span tables; that requires a trigger, and
triggers are hand-written per-dialect SQL — reintroducing exactly the portability problem
being avoided. Prisma's schema language cannot declare either.

**Decision.** Drop the claim. The invariant is enforced in `InventoryService` (per §1 above)
and independently audited by a scheduled integrity job that reports violations through the
same alerting path as reconciliation drift.

---

## 4. Postgres-only migration history in Phase 0

§3 requires "CI runs the full test suite against Postgres, MySQL, and SQLite matrices."

Prisma cannot share one migration history across providers: `datasource.provider` must be a
string literal, and generated migration SQL is dialect-specific. Supporting three dialects
requires either per-provider schema codegen with three parallel migration directories, or
demoting the non-reference dialects to `prisma db push` with no upgrade path.

**Decision.** Ship a Postgres-only migration history in Phase 0 and defer the mechanism.
MySQL and SQLite are **not supported targets** until it lands, and the README says so.

**Consequences.** The 3-DB test matrix does not exist yet. As a partial substitute, CI runs
`pnpm --filter @hub/db validate:all`, which validates the canonical schema against all three
providers. That catches violations of the portability rules — dialect-specific types,
unsupported scalars — but proves nothing about behavioural parity. Do not mistake a green
`schema-portability` job for multi-database support.

---

## 5. Open items deliberately not decided

- **Multi-location inventory.** Shopify's inventory API is location-scoped
  (`inventory_levels/update` fires per location; `inventorySetQuantities` requires a
  location ID), but the model has one `InventoryItem` per SKU with no location dimension.
  v1 pins a single `locationId` in the Shopify channel config and ignores all others.
  Retrofitting real multi-location means splitting `InventoryItem` — the most expensive
  change in the model. Revisit before v1 ships, not after.
- **Per-lot cost basis.** `costBasis` is one scalar per `InventoryItem` and cannot represent
  units acquired at different prices, which is normal for card inventory and matters for
  COGS. Out of scope for v1; noted because it is cheap now and expensive later.
- **`StockMovement`.** Added beyond the spec: an append-only ledger of every `quantityOnHand`
  delta with a reason code. `SyncEvent` logs channel I/O but nothing recorded "a human
  intook 5 copies." Free to add now, a migration to add later.
