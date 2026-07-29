<!--
Thanks for contributing. CONTRIBUTING.md has the full rules; this is the short
version of what a reviewer will look for.
-->

## What this changes

<!-- And why. If it fixes an issue, "Fixes #123". -->

## How it was verified

<!--
Not "tests pass" — what did you actually run, and against what? If it touches a
connector, say whether it was exercised against a real account or only mocks.
Both are acceptable; which one it was matters to a reviewer.
-->

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm lint`, `pnpm typecheck` **and `pnpm format:check`** all pass — `format:check` is
      a separate CI gate that `lint` does not cover, and it runs first, so a Prettier slip
      fails the build before anything else gets a chance to
- [ ] Touched `schema.prisma`? Ran `pnpm --filter @hub/db validate:all`, and the migration
      backfills existing rows where a new column needs it
- [ ] No credentials, real shop domains, account ids or seller names in any tracked file —
      placeholders read just as well in a fixture

## The rules that are not negotiable

Confirm any that your change comes near — these are in `CONTRIBUTING.md` because breaking
them produces bugs that only surface on someone else's database or someone else's
marketplace account:

- [ ] **No raw SQL in core.** ESLint blocks it; it breaks the MySQL/SQLite targets
- [ ] **No nullable column in a `@@unique`** meant to prevent duplicates — `NULL != NULL` on
      all three dialects, so it silently never fires
- [ ] **All quantity mutations go through `InventoryService`**
- [ ] **Connectors never compute quantities** — they translate; the core decides
- [ ] **All alerts go through `AlertsService`** — `raiseFlag` for a condition that stays
      true, `raise` only for facts needing individual resolution, like an oversell
- [ ] **No `import type` for anything NestJS injects** — it typechecks, then DI fails at
      runtime because `design:paramtypes` degrades to `Object`

## If this adds a test

- [ ] It can fail. A test that only ever asserts rejection will pass against a component
      that cannot succeed — that is exactly how webhook ingress stayed unverified through
      two green tests. Break the code deliberately and confirm the test goes red.
