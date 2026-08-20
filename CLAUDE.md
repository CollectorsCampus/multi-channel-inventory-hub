# Working notes for Claude

Context for anyone (human or model) picking this project up. The design documents
(`docs/TECHNICAL_DESIGN.md`, `docs/PROJECT_OVERVIEW.md`) describe the _intent_; this file records what
was actually built, where reality diverged, and the rules that keep it coherent.

**`docs/TECHNICAL_DESIGN.md` is authoritative — except where an ADR supersedes it.** It now
sits beside the ADRs that amend it, which is the point; §-citations throughout the code name
the document rather than its path, so they were unaffected by the move. Several
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
| 5     | Reconciliation, alerting polish, query console, OIDC, release           | Done — **v0.5.0 released 2026-08-07** |

Everything in "After v0.1.1" below shipped in **v0.2.0**: the container-start fix, the
tcgcsv catalog source, and the match-proposal workflow. The section keeps that heading
because it explains _why_ each landed, which the CHANGELOG does not. Everything in "After
v0.2.0" shipped in **v0.3.0**, for the same reason.

`main` is green: **1286 tests** (api 790, shopify 162, tcgplayer 102, sdk 61, tcgcsv 49,
cardtrader 37, web 35, scryfall 28, palworld 15, db 7), lint/typecheck/format/build clean —
on **vitest 4** and **bullmq 6** now (see the dependency section below). `apps/web` has
tests — the card-image and tag-suggestion grammars. **Count these rather than
trusting a remembered total**: several older commits say "990", which was simply
added up wrong, and the api total in particular moves every feature. Note that the
DB-backed api suites **skip** without `TEST_DATABASE_URL`/`TEST_REDIS_URL`, and a recursive
`pnpm -r test` does not propagate those to child processes (the pnpm-shim quirk under
Environment notes) — so a plain `pnpm -r test` under-counts; count with the env set, per
package. **Five jobs run on a push** —
`ci.yml`'s build, schema-portability, test and docker, plus CodeQL's analyze in its own
workflow. `release.yml`'s image job is the sixth and fires only on a `v*.*.*` tag.

### v0.1.0 (2026-07-29)

Tagged at `35ecf98`. `release.yml` published a multi-arch image — `linux/amd64` and
`linux/arm64` — as `ghcr.io/collectorscampus/multi-channel-inventory-hub`, tagged `0.1.0`,
`0.1` and `latest`, digest `sha256:42ead987…`. A GitHub Release carries the CHANGELOG's
0.1.0 section.

**The repository went public on 2026-07-29**, after the history audit below. GitHub detects
the licence as AGPL-3.0, and the repo, the `v0.1.0` release and the source are all readable
anonymously.

**The container package is a separate switch**, and had to be flipped by hand after the
repository — repository visibility does not propagate to GHCR. There is no REST endpoint to
change it for a **user**-owned container package; it is done at
`https://github.com/users/<user>/packages/container/<package>/settings`. Both are now
public, verified with an anonymous registry token: the tag list returns `0.1.0`, `0.1` and
`latest`, and the `0.1.0` manifest resolves to real `linux/amd64` and `linux/arm64`
children.

**Test that anonymously, never from your own session.** The failure is silent from the
owner's side — an authenticated pull succeeds whether or not the package is public, so
checking it while logged in reports success for every visitor who is actually being
refused.

Four things learned doing it, none of them guessable:

- **`latest` is applied by `docker/metadata-action`'s default `flavor: latest=auto`**, not
  by the workflow's `type=raw,value=latest,enable={{is_default_branch}}` rule — that rule is
  false on a tag push and never fires. The explicit line is redundant; the tag appears
  anyway.
- **The multi-arch build takes ~14 minutes**, nearly all of it `arm64` under QEMU. It is not
  hung.
- **`gh` needs the `read:packages` scope** to list published container versions. Without it
  the tags have to be read out of the build log, which does show them.
- **Do not pass non-ASCII through `gh --title` from bash** — an em dash arrived as `â€"`.
  Pass a UTF-8 JSON file to `gh api --input` instead. `--notes-file` was unaffected, so only
  argv is the problem.

Versions are unified at 0.1.0 across every manifest, and the OpenAPI document reads its
version from `apps/api/package.json` rather than repeating it. `0.x` is deliberate: MySQL
and SQLite have no migration history, no real IdP has completed a login, and there is one
store's worth of production evidence.

### v0.1.1 (2026-07-29)

A dependency-only security release, tagged at `3f31390`. Multi-arch image at
`ghcr.io/collectorscampus/multi-channel-inventory-hub`, tagged `0.1.1`, `0.1` and `latest` —
all three at digest `sha256:2e900253…`, replacing `sha256:42ead987…`. **Dependabot now reports
0 open alerts and 18 fixed.**

The build took ~5 minutes, not the ~14 that v0.1.0 took, because the arm64 layers were
already in the GitHub Actions cache. Do not read a fast release as a skipped one.

**Verification worth repeating rather than re-deriving.** Anonymous registry token first, as
always — but the stronger check is to pull the published image and look inside it, which is
the only thing that proves an override actually reached the artifact:

```
docker run --rm --entrypoint sh ghcr.io/…:0.1.1 -c 'ls /repo/node_modules/.pnpm | grep -E "static|find-my-way|js-yaml"'
```

It shows `@fastify+static@10.1.2`, `find-my-way@9.7.0` — **one** copy, where 0.1.0 had two —
and `js-yaml@5.2.2`. It also shows no `vite`, `vitest` or `esbuild` at all, which is the
empirical form of "the runtime stage installs `--prod`" and the thing that makes the
runtime/dev advisory split real rather than asserted.

Then boot it. The image was run against the throwaway services on 5433/6380 and driven over
HTTP: liveness, the SPA index, and the real 376 kB hashed bundle with
`application/javascript`. That last one is not ceremony — `@fastify/static` 10 leaves an
unmet peer and `useStaticAssets` resolves the plugin at **runtime**, so serving a real asset
from the real image is the only place that combination is actually proven. Five traversal
attempts read nothing outside the web root.

One surprise: pointing the container at the **test** Redis made the outbound worker spend a
minute failing jobs left in the queue by the test suites, for allocations those suites had
truncated. Harmless, and not a defect — but it looks alarming in the logs, so expect it.

`--notes-file` handled the em dashes correctly, confirming that only `gh --title` mangles
non-ASCII from bash.

### v0.1.0 shipped known vulnerabilities — all cleared in v0.1.1

Enabling Dependabot alerts on 2026-07-29 immediately surfaced **18 open advisories**. They
were all present before that switch; turning it on is what made them visible, which is the
whole argument for having done it. But they were present in the image published as v0.1.0.

**All 18 are fixed.** They collapse to nine distinct advisories across six packages, and the
tree now resolves a patched version of every one — verified by comparing each alert's
vulnerable range against the lockfile, not by watching the alert count. Two needed
`pnpm.overrides`; four fell out of the vitest upgrade. Details below.

**In the runtime image, so in the shipped product:**

| Package           | Severity | Issue                                      | Installed | Patched |
| ----------------- | -------- | ------------------------------------------ | --------- | ------- |
| `@fastify/static` | high     | Route guard bypass via **path traversal**  | ^9.3.0    | 10.1.1  |
| `@fastify/static` | medium   | Authorization bypass, non-canonical paths  | ^9.3.0    | 10.1.2  |
| `find-my-way`     | high     | HTTP/2 denial of service                   | 9.6.0     | 9.7.0   |
| `js-yaml`         | high     | Exponential parse time → denial of service | 5.2.1     | 5.2.2   |

**All four are patched, and none of them was reachable here.** That second half was written
into this file as the opposite — "`@fastify/static` is the one to take seriously … path
traversal there is precisely the surface it is exposed on. Not theoretical." That was wrong,
and it was wrong in the direction that costs the most: it reads as a live hole in a
published image. Each advisory states its own precondition, and none of them holds:

| Advisory                 | Needs                                             | Here                                                                             |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@fastify/static` high   | a route guard or middleware over the served files | Nothing guards the SPA bundle — it is public by design                           |
| `@fastify/static` medium | `allowedPath` used as a security boundary         | `allowedPath` is never passed; the only call is `{ root, wildcard: false }`      |
| `find-my-way` high       | a Node **HTTP/2** server                          | No HTTP/2 anywhere; `NEST_APP_OPTIONS` is `{ rawBody: true }` over HTTP/1.1      |
| `js-yaml` high           | `load()`/`loadAll()` on untrusted input           | Reached only via `@nestjs/swagger`, which calls `jsyaml.dump()` and nothing else |

The high's own advisory text gives the workaround as "do not use route-based middlewares or
guards to protect files served by `@fastify/static`" — which is a description of what
`serveSpa` already did. Checked empirically too: eight escape attempts and ten non-canonical
spellings of a guarded route behave **identically** on 9.3.0 and 10.1.2, with no file read
from outside the web root and no guard bypassed. `boot.spec.ts` now pins that.

So the upgrade is hygiene and insurance, not incident response: it clears the alerts, and it
means a future change that _does_ put a guard in front of static files cannot silently
inherit a bypass. Worth doing promptly. Not worth telling users their v0.1.0 was exploitable
— as far as could be determined, it was not, and the reachability argument above is the
reason, not the probe results.

**The two transitives needed `pnpm.overrides`, not bumps**, which is why Dependabot never
opened a PR for either: `@nestjs/platform-fastify` depends on `find-my-way: 9.6.0` and
`@nestjs/swagger` on `js-yaml: 5.2.1`, both **exactly**, and both parents are already the
newest. Refreshing `find-my-way` moved only `fastify`'s copy and left the adapter's second
one in the image — so "the lockfile no longer mentions 9.6.0" is the thing to verify, not
"the update ran". The `js-yaml` override is scoped to `js-yaml@5`, because eslint pulls an
unrelated 4.3.0 that an unscoped override would have dragged across a major.

**`@fastify/static` 10 leaves a permanently unmet peer.** `@nestjs/platform-fastify` 11.1.28
wants `^8 || ^9`, and no 11.x accepts `^10`. It installs because
`strict-peer-dependencies=false`, and it demonstrably works — but `useStaticAssets` resolves
the plugin at runtime (rule 8), so nothing static will tell you if that stops being true.
That is why the new test fetches the real hashed bundle and checks the content type instead
of trusting a green boot.

**Development-scope only** (the test runner, not in the image): seven `vitest` advisories,
all the same critical — the Vitest UI server can read and execute arbitrary files. Worth
fixing, but it does not ship.

**`esbuild` cannot be auto-fixed.** Dependabot reports `security_update_not_possible`: the
lowest non-vulnerable version is 0.28.1 but the tree only resolves to 0.21.5, because Vite 5
pins it. The fix is the Vite major, which is why PR #3 exists — a security update overrides
the `ignore` rule in `dependabot.yml`, so ignoring vite majors does not block it.

**Remaining order:** `vitest`, then the Vite major, which needs the build actually exercised
rather than just a green test run. Then cut **v0.1.1** — the published `0.1.0`, `0.1` and
`latest` tags all carry the four above, and `latest` is what a new user pulls.

Dependabot opened **8 PRs** on its first run, 7 of them majors. The `ignore` list in
`dependabot.yml` covers only Prisma, NestJS, Vite and React; TypeScript 5→6, ESLint 9→10,
Zod 3→4, vitest 2→3 and `@vitejs/plugin-react` 4→6 all came through. That is real accumulated
drift rather than noise, but the list may want extending once the security ones are cleared.

**Every one of those 8 PRs failed CI, all for the same unrelated reason**, and it is worth
knowing before wondering whether a bump broke something. `prettier --check .` had no ignore
file, so it checked `pnpm-lock.yaml` — and pnpm's YAML output does not match Prettier's
preferences. The committed lockfile satisfied both by luck, so `main` stayed green and the
problem was invisible until something regenerated it. `format:check` is the first step of the
build job and is not covered by `pnpm lint`, so all eight died there, on a file no human
wrote and that Dependabot cannot reformat. `.prettierignore` now exists; the repo had already
been describing that file as generated in `.gitattributes` (`linguist-generated=true -diff`),
which is the same judgement.

### Pre-publication audit (2026-07-29)

Git history was audited before any decision to go public — all 42 commits and every object
in every tree, not just the working copy. **No credential has ever been committed.**

- `private/` has zero objects in history, so the operator's `shopify.local.json` and their
  real TCGPlayer exports — including `ShippingExport` and `PackingSlips`, which carry
  customer names and postal addresses — never entered git.
- Searching history for the literal `clientId`, `clientSecret` and `locationId` values from
  the live credentials file returns zero hits. No token matches the real
  `shp(at|ss)_[0-9a-f]{32}` shape; every `shpat_`/`shpss_` in the tree is a fixture. No AWS,
  GitHub, Slack or OpenAI keys, and no private keys.
- Every path ever committed still exists, so nothing is hidden in history that is absent
  from the tree. The only high-entropy strings are the documented all-`A`/all-`B` CI test
  keys. The committed PDFs predate the live-store work and carry no author metadata.

**One real finding, fixed in the tree:** the operator's actual store domains — the vanity
one, which names their business, and the permanent one — had reached `CLAUDE.md` and a
webhook test fixture. Not credentials, but they tie the repository to a specific shop.
Replaced with placeholders. **They remain in history**, which was accepted deliberately: a
`filter-repo` rewrite would change all 42 SHAs and orphan the `v0.1.0` tag, the GitHub
Release and the published image's `revision` label, which is a poor trade for a domain
anyone can find by visiting the store.

**The rule this leaves:** never put a real shop domain, account id or seller name in a
tracked file. Placeholders (`test-store.myshopify.com`, `abc123-45.myshopify.com`) read
just as well in a fixture, and the real values belong in `private/`. Note that
`nick@collectorscampus.com` authors every commit and will publish with them; that is
normal for open source and was not treated as a defect.

### After v0.1.1 — PRs #13, #15–#18 (2026-07-29/30)

Everything in this section is on `main` and shipped in **v0.2.0**. It is the work that
turned a store the hub could not touch into one it can enumerate and link. (PRs #21–#44,
below, landed _after_ the v0.2.0 tag and shipped in **v0.3.0**.)

#### The published images cannot start offline (#13)

`docker/entrypoint.sh` ran migrations through `pnpm --filter @hub/db exec prisma migrate
deploy`, and **pnpm is not in the runtime image.** The `runtime` stage is a fresh `FROM
base`, so it inherits `corepack enable` — a shim — and none of the pnpm the build stages
downloaded. Corepack therefore fetched `pnpm-9.15.4.tgz` from registry.npmjs.org at _every
container start_.

It fails as a **hang, not an error**: the container sits in `starting`, goes `unhealthy`,
never serves a request, and the only clue is one "Corepack is about to download" line. The
hung fetch also leaves it uninterruptible, so `docker rm -f` cannot reap it — which is the
cause of the wedged container mentioned under Environment notes.

Fixed by calling the CLI through its own bin symlink in a subshell (`cd packages/db &&
./node_modules/.bin/prisma migrate deploy`). **This affected the published 0.1.0 and 0.1.1
images**, so a deployment behind an egress filter could never have started either. Worth
folding into the next tag.

#### `optionalSecretFields` (#15)

A Shopify channel configured the normal way — `clientSecret` only — was labelled
permanently, in error styling, "Not connected yet — still needs: webhookSecret". It was
connected, and worse, the operator was sent hunting in the Dev Dashboard for a credential
**Shopify does not issue**.

Root cause was in the SDK: `secretFields` is a flat list with no way to say "only for the
unusual case", so `channels.service` had no choice but `secretFieldsRequired:
[...secretFields]`. `Connector.optionalSecretFields` is now a subset of `secretFields`;
unmarked fields stay required, because a connector that forgets to mark one optional
produces a prompt, while one that wrongly marks a required field optional produces a
channel that fails at runtime. The form labels them "— optional" too: fixing only the
warning would have left an unlabelled empty password box, which causes the same search.

#### `packages/catalog-tcgcsv` (#16) — a prototype, and it says so

tcgcsv.com as a `CatalogSource`: TCGPlayer's product catalogue and reference prices for the
90 categories it publishes. It exists because Scryfall covers Magic and nothing else, while
the operator's real inventory spans One Piece, Lorcana, Flesh & Blood, Union Arena, Gundam,
sleeves, deck boxes and playmats.

Four things about it that are not guessable:

- **The CDN answers 401 to an empty or generic `User-Agent`**, and Node's `fetch` sends
  none. Every test passed while production was fully broken, because tests stub `fetch` and
  never exercise a header. **Any new HTTP client in this repo needs an explicit UA**; a
  blank override falls back to the default rather than reintroducing the 401 silently.
- **There are no per-condition prices, and there never will be.** tcgcsv does not publish
  the SKU tier, and its definition of a SKU — product + language + printing + condition —
  is exactly `Sku`'s natural key here. Its `productId` is **product-level** and is a
  different id space from the SKU-level `TCGplayer Id` an allocation's `externalListingId`
  holds, so these prices cannot be keyed to a listing. Catalogue and market reference, not
  a price feed.
- **It is an importer wearing a search interface.** Static files on a CDN, no search
  endpoint, so `search()` fetches and filters whole set files. An un-narrowed search
  **throws** rather than hammering the CDN or returning a silent fraction — a missing card
  looks identical to a card that does not exist. Two caps enforce it: at most 2 categories
  (so "Pokemon" plus "Pokemon Japan" still works) and at most 4 set files per search.
  Requiring a _set_ is not enforced here; that is a review-size policy owned by
  `MatchingService`.
- **`fetchById` only resolves products from sets already read**, because tcgcsv publishes
  no product-to-set index. That covers the flow that matters — search a set, confirm out of
  it — and returns null for anything unseen rather than scanning ~4,000 files.

The honest production shape is a scheduled bulk ingest into `CatalogItem` /
`CatalogExternalRef` with search served from the database. That needs ingest machinery the
core does not have, which is why this is labelled a prototype. **That machinery now
exists** — see the catalog ingest (#24) below.

#### The hard blocker this all existed to fix (#17)

`ChannelAllocation.externalListingId` had exactly one writer — the outbound worker, from
`pushListing`'s result — and Shopify's `pushListing` **refuses to run without one**.
Nothing in the API could set it. So for an operator with an existing storefront the field
could never be populated and every push failed forever. A closed loop, not a missing
convenience. `AllocationWrite` now carries it: absent means "leave alone", explicit null
detaches a link without destroying the allocation and its quantities.

#### Match proposals (#17, #18)

Two new capabilities and a review screen at `/match`.

**`listing.enumerate` → `enumerateListings`.** Distinct from `reconcile`, and the
distinction is the point: `fetchLiveState` answers "what do you say about _these_ ids",
which presupposes we already hold them. Nothing answered "what are you selling that I have
never heard of". It deliberately does **not** affect `syncMode` — it says nothing about
order freshness, and letting it promote a manual channel to "continuous" would make
reconciliation read expected staleness as drift.

- Shopify's implementation **reports no quantity, on purpose**: inventory levels per
  variant would multiply query cost by page size and hit the calculated-cost limit on any
  real catalogue. It does carry `sku` and `barcode` — the only fields that can make a match
  certain rather than probable.
- **`search` is a best-effort hint, not a contract.** A connector whose platform has no
  search returns everything, so the core must never assume a returned listing matches. It
  earns its place because matching is scoped to one set while a page of a real storefront
  is not: enumerating 100 variants of the live Pokémon shop to match one set gave **2
  matches and 98 rows of noise**, and the noise is what stops a review screen being read.

**`apps/api/src/matching/propose.ts` is pure functions**, the way `allocation.ts` and
`reconcile.ts` are. The rule that shapes it: **nothing is ever applied, everything is
proposed with its reason**. A tie at the best confidence is reported as `ambiguous` with
both candidates listed, never resolved by taking the first — reprints make that tie the
common case. A wrong link points inventory at the wrong listing, so the next sale
decrements the wrong SKU and it surfaces days later as drift nobody can explain.

Evidence is ranked in the operator's terms, not as a score: `barcode` and an exact
`external-id` are **certain**; `external-id-embedded` and `name-and-set` are **probable**;
bare `name` and `name-partial` are **possible**. Only `certain` is counted safe to
bulk-accept.

Two findings from real data:

- **Condition text must come off the title before names are compared.** A variant is
  "Pikachu ex - Near Mint Foil" and the catalogue knows "Pikachu ex". The vocabulary is
  borrowed from `connector-tcgplayer`'s `parseCondition` because it is the same vocabulary
  sellers type and it already refuses to guess.
- **The qualifier can itself contain " - "** — the grammar is `<condition>[ <edition>][
<finish>][ - <language>]`, so "Near Mint Holofoil - Japanese" is one qualifier in two
  segments. Splitting on the last segment sees "Japanese", fails, and drops the language.
  The search runs shortest-tail-first and refuses a tail that would swallow the whole
  title, so "Commander - Star Trek" keeps its name.

`deriveSkuDimensions` returns `undefined` rather than defaulting to Near Mint. A default
would be the software deciding a card's condition, and condition is most of what a single
is worth.

**Barcode is unreachable today, and must stay that way with tcgcsv.** Two separate facts,
both measured on 2026-07-30:

1. **Nothing populates it.** `CatalogCandidate` has no barcode field, and `toTarget` never
   sets `MatchTarget.barcode`, so the `barcode` branch of `bestReasonFor` cannot fire for a
   catalogue-sourced target. It is currently dead code.
2. **tcgcsv's `extUPC` must not be plumbed into it.** The column exists and is parsed onto
   `TcgcsvProductRow.extended`, which makes wiring it up look like a free win. It is not —
   and it is not free either: `toCandidates` drops `extended`, `CatalogCandidate` has no
   field for it and `CatalogItem` has no column, so "carried through" stops at the row.
   Measured across five real Pokémon sets: only **74 of 2112 rows** carry one (3.5%, sealed
   only), and **the values are not unique** — `196214136113` is on both "Mega Evolution
   Booster Pack" and "Mega Evolution Booster **Box Case**", and `196214143340` on both the
   Sneasel and Weavile blisters. One live store barcode (`820650853319`) matches a
   completely unrelated tcgcsv product.

`barcode` is ranked **certain**, the one tier offered for bulk acceptance. Feeding a
non-unique, 3.5%-covered field into it would let a $5 booster pack be certain-matched to a
~$3000 booster box case. The tie logic would catch the cases where two candidates collide,
but not a single wrong one. So the `certain` path stays reachable only through the SKU
field, which is the argument for `listing.sku`.

**`MatchingService` — `POST /channels/:id/match/propose` and `/confirm`.** Scoped to one
set, and that is a choice about the human: 1,300 proposals in one screen do not get
reviewed, they get accepted wholesale. An unscoped run is refused before either side is
touched. Confirmation never trusts the client for catalogue data — it carries ids and SKU
dimensions only, and the name and external ids are re-fetched server-side for the reason
`IntakeDto` already gives. Links are applied sequentially, because two can land on the same
inventory item and `upsertAllocation` takes the optimistic-locking path; one bad row
reports a problem and the rest still land.

Candidates are keyed on **`source.key`, not the request string** — CodeQL flagged the
latter as remote property injection and was right to.

`IntakeService.ensureSku` exists because `intake` requires a positive quantity and rightly
so. Linking is identity: inventing a quantity would credit stock nobody counted, and a
delta-0 `StockMovement` would be a lie in the audit trail.

#### `listing.sku` — opt-in, off by default, **destructive** (#18)

`updateListingSku` writes the catalogue's product id into the channel's own seller-SKU
field, so a hub rebuilt from nothing re-derives every link from the platform instead of
asking the operator to match 1,300 items again. It also promotes future matches from a name
resemblance to an exact id — the `certain` path.

**It overwrites, and a seller SKU usually means something to its owner.** The operator's
Shopify variants carry a live internal scheme (two prefix families, populated on every
variant sampled) and this replaces it. That was raised with evidence and **explicitly
authorised** — and has since been carried out; see "The SKU decision" below.

The code is built so it cannot happen by accident: off unless the request asks; only ever
applied to a listing whose link was _just confirmed_; requesting it on a connector that
cannot do it is an **error, not a silent no-op**; an empty SKU is refused in the connector,
because Shopify would accept it and the seller's code would simply be gone; and the UI
checkbox defaults off and is not remembered between runs.

**Ordering is deliberate: the channel is written only after the link is recorded locally.**
The reverse would leave the storefront stamped with an id this hub has no allocation for —
a lie that survives a restart and that reconciliation cannot explain.

Shopify keeps a variant's SKU on its **inventory item**, so this goes through
`productVariantsBulkUpdate` with `inventoryItem: { sku }` — same mutation and same
`write_products` scope as the price write. Written **verbatim, never normalised**: a test
asserts `00704143` is not tidied to `704143`, because the matcher's certain path is an
equality test and a normalising connector would quietly turn tomorrow's exact match back
into a guess. Rate limited through the connector's declared limit, as reconciliation does
it — Shopify allows 2/s and a batch of forty confirmations would burst straight through.

#### Two channel listings could silently steal one item's link — fixed 2026-07-30

`applyLink` guarded one direction only. Two inventory items claiming one listing was
refused; the reverse — a **second listing resolving to an item the channel already drives**
— was not, and could not add a row, because `@@unique([inventoryItemId,
channelInstanceId])` permits one allocation per item per channel. So it **moved** the
existing one: the first listing was silently detached and `confirm` still counted it as
linked. The operator was told two listings were managed while one had quietly stopped
being, with no error and nothing in the audit trail.

Found on the live store, where the **Pokémon Center Elite Trainer Box and the regular
printing both propose the same catalogue product** — tcgcsv carries one product for both.
It is not an edge case: a case beside a pack does it too.

Now refused, naming the listing that already holds the item. Deliberately refused rather
than resolved, for the same reason `propose` reports a tie instead of picking: which
listing should own the stock is the operator's call. An allocation that exists but is
_unlinked_ (what intake leaves behind) is still linkable — the guard only fires on a
different **non-null** id, and a test pins that so it cannot tighten into blocking intake.

Verified live: submitting both ETBs returned `linked: 3` plus one problem, and the first
link survived. Before the fix the same request returned `linked: 4` with three rows.

#### The SKU decision — carried out 2026-07-30

**139 SKUs have been written to the live store and verified — zero mismatches.** The
precaution held: **all 867 original SKUs were exported first**, to
`private/shopify-sku-backup-2026-07-30T16-38-55.csv` (gitignored), so the overwritten
scheme is recoverable if the operator ever wants it back.

**The store's own SKU field was half empty and not unique**, which was measured rather than
sampled and corrects the earlier note that two prefix families were "populated on every
variant sampled". Of **867 listings, 434 carried a SKU** — so the overwrite was a no-op for
half the store — across many more than two families (`##-#####-###`, `###-#####`,
`UGDSQR######`, `ULP#####`, `PKU#####`, …). And it did not identify a variant: the Psyduck
and Golduck 3-pack blisters shared both SKU `10-10050-122` and barcode `196214136106`.
Whatever that field was, it was not a key — which is why overwriting it was cheap.

**What was written is TCGPlayer's _product_-level id** (tcgcsv's `productId`), not the
SKU-level `TCGplayer Id` a TCGPlayer allocation's `externalListingId` holds. That is the
right granularity for sealed product, where one product is one variant — and the **wrong**
granularity for singles, where condition, printing and language all live below the product
id. Settle the singles id scheme before matching singles, or the `certain` path will
equate different conditions of the same card. **That is what #32 settled and what the
2026-07-31 re-stamp replaced these ids with** — every one of the 139 now carries a full
code. This section is kept because it records what the field held before, and why
overwriting it was cheap.

#### Matching against the live store, as it actually behaves

Every live match of an **unlinked** listing comes back **`possible` · `name-partial`**,
because store titles are prefixed ("Pokémon TCG: Mega Evolution Phantasmal Flames …") and
tcgcsv's are not. That has not changed. What has: the 139 linked listings now carry a hub
SKU code, and re-matching one of them reaches **`certain` · `hub-sku`** — observed on
2026-07-31, below.

Two things about the shape of the data, both of which cost time to work out:

- **The store organises Pokémon by sub-set, and tcgcsv agrees — under different names.**
  The store's "Mega Evolution Ascended Heroes", "Perfect Order", "Chaos Rising" and "Pitch
  Black" are `ME: Ascended Heroes`, `ME03`, `ME04` and `ME05` in tcgcsv. A run named
  "Mega Evolution" matches only the three literal `Mega Evolution` groups and leaves the
  sub-sets unmatched, which reads like a failure and is not. **Match each sub-set by its
  own name.**
- **Shopify titles carry a ` - Default Title` suffix** on single-variant products, which
  `splitChannelTitle` cannot strip because it is not a condition. Containment matching
  absorbs it, so it does no harm today — but it is why nothing here will ever match on a
  whole-string comparison.

**Progress: 139 allocations, all sealed Pokémon**, up from 3. Every one is a distinct listing
and a distinct inventory item, all priced, `listedQuantity` 0, and the ledger still holds a
single `StockMovement` — linking credits no stock, as designed. What remains unmatched is
genuinely uncatalogued: binders, event tickets, Build & Battle boxes, mini tins and
"Moonlit Tin", which tcgcsv does not carry at all. Magic, Lorcana, One Piece and the other
lines are untouched.

### After v0.2.0 — PRs #21–#44 (2026-07-30 to 08-02), all shipped in **v0.3.0**

#21 and #22 are research only — webhook delivery over a cloud bus, and the connector
candidates — and their findings live under "Open decisions" below, where they gate real
choices.

#### `overlap` — what counts as a `name-partial` tie (#23)

Containment is not a measure of similarity, and treating it as one made the review screen
unusable for a whole set on a live run: tcgcsv carries a card literally named
"Winterspell" in the Winterspell set, and because `name-partial` fires on containment in
either direction, that card was contained by every sealed listing in the set — so it tied
with the correct product on all four and every one came back `ambiguous`.

They were never equally good evidence: for the booster pack the right product's name
accounted for 76% of the listing's title, the card's for 22%. `MatchCandidate` now
carries that ratio as `overlap` — `min(len)/max(len)` over the normalised names —
candidates sort by confidence then by it, and the tie test gains the same term.

**This is not a loosening of the never-resolve-a-tie rule; it is a correction to what
counted as a tie.** Names of equal length still tie exactly, so two reprints with
identical names behave exactly as before, and a test pins it. `overlap` is 1 for every
reason that is not a name resemblance — an exact id must not lose to a long name that
nearly matches — and it is **deliberately crude**: edit distance or token overlap would
start _creating_ matches rather than ordering them, which the engine exists to refuse.

#### The local catalog is filled by ingest, and read first (#24)

The tcgcsv source has described a bulk ingest as its "honest production shape" since it
was written; #24 built it. Three live failures made the case, and none is the
connectivity worry that usually motivates a cache: `fetchById` forgets its product index
on restart (a confirm after a container restart failed with "tcgcsv has no product
654154" **mid-way through writing SKUs to a live storefront**); an un-narrowed tcgcsv
search throws by design, so nothing could browse; and it is a community CDN with no SLA.

- **`listSets` / `fetchSet` are two new optional `CatalogSource` methods, declared
  together** — `validateCatalogSource` rejects one without the other. They are not
  `search()` with a broad query: search makes the source decide what to omit and cannot
  enumerate a set exhaustively. The pairing mirrors `listing.enumerate` for the same
  reason. tcgcsv's `fetchSet` populates its product index as a side effect, which is what
  makes `fetchById` work for anything ingested.
- **Catalog-item creation stays owned by `IntakeService`** (`ensureCatalogItem`), because
  a second implementation of "are these the same product" would eventually disagree, and
  that disagreement surfaces as duplicate items nobody can merge. Ingest passes an
  ingest-only `refresh` option — re-reading the authoritative source is the point of a
  bulk run, while an intake has no business rewriting an item's identity — and refresh
  writes only when something differs, so a nightly re-ingest does not bump `updatedAt` on
  unchanged rows.
- **`CatalogIngestModule` is its own module** because it needs both the source registry
  and `IntakeService`, and putting it in `CatalogModule` would need `forwardRef` — which
  works, then quietly turns every future construction-time dependency between the two
  modules into a runtime undefined.
- **A run wider than `maxSets` is refused, not truncated** — the first 50 of Magic's 453
  groups would leave a catalog that looks complete and is not. One unreadable set is
  reported and the rest still land.
- **Prices are deliberately not stored.** tcgcsv republishes them daily; a stored price is
  a stale price with a timestamp nobody checks. Identity is durable, prices are not. No
  schema change — `CatalogItem` / `CatalogExternalRef` already model this.
- **`fetchCandidate` resolves locally first** — `CatalogExternalRef` then `CatalogItem` —
  and that is **not a cache**: the caller must not choose what gets written to
  `CatalogExternalRef`, and a row we wrote ourselves satisfies that completely, without a
  network call. Falls back to the source for anything never ingested. The local candidate
  carries no `marketPrice`, deliberately: a caller wanting a live price should ask the
  source explicitly rather than silently receive a stale one.

**Live state: 433 catalog items ingested across 27 Pokémon sets.** The ingest fixing the
restart failure was itself only proven by restarting the container and reproducing the
original error — the first version did not actually fix it, because `fetchCandidate`
still went to the source.

#### The local catalog is browsable and matched against (#26)

The ingest made the catalogue durable; #26 makes it usable. `GET /catalog/local/sets`
answers "what is in here" with per-set item counts — the question no remote source here
will take — and `GET /catalog/local/search` searches it with no network at all. Both are
deliberately separate from `/catalog/search`, which fans out to third parties and reports
per-source failures; the local query is one database read that either works or does not,
and a shared response shape would be half about network problems that cannot occur.

**Matching now draws candidates from the local catalog first**, which is where it is
worth most: a proposal run needs the _whole_ set as candidates, precisely the request
tcgcsv is least willing to serve. Measured live: 158 candidates for Phantasmal Flames
from the ingested set against 28 from a live tcgcsv search. It falls back to the source
for any set never ingested.

Three things learned building and reviewing it:

- **Exact set-name match first, then containment** — sources store
  `ME02: Phantasmal Flames`, operators type `Phantasmal Flames`, and exact-only matching
  missed on the only spelling a human uses, silently falling through to the network while
  looking like it worked. Found by driving the app, not by the tests. The match is
  **case-sensitive and stays so**: there is no lowercased copy of `setName` the way
  `searchName` exists for names, and `mode: "insensitive"` is PostgreSQL-only.
  Callers wanting certainty take a name from `local/sets` rather than typing one.
- **`pickAttribution` presents an item under one `(sourceKey, sourceId)` pair** — an
  ingested item carries both `tcgcsv` and `tcgplayer` refs, and that pair is what
  `fetchCandidate` is later asked to re-verify. Sorted before picking so the choice does
  not depend on database row order.
- **Matching only offers local rows the _requested_ source can re-verify** (review
  finding, fixed pre-merge). Confirmation re-verifies the `(sourceKey, sourceId)` pair
  the client sends, and the `/match` form sends the source the run was asked for — so a
  local row ingested from a different source would have filled the review screen with
  plausible matches whose every confirm then fails with "no such product", after the
  human already did the review work. Local rows are filtered to those carrying a ref for
  the requested source, with the proposed id re-read from that ref; a set ingested from a
  different source falls back to the live search exactly as an un-ingested one does. Not
  reachable while tcgcsv is the only ingesting source — the first Magic ingest plus one
  scryfall-scoped propose would have hit it.

#### The catalog screen (#29)

`/catalog` in the web app, in the top nav: the local catalog browsable (sets held with
counts, click a set to browse it — the click fills the search with the **stored**
spelling, because set names are case-sensitive downstream), local search, and an
admin-only ingest panel that lists a source's sets (newest first), takes an explicit
selection, runs, and shows the report. Ingest was API-only before this; every hole the
session prompt named — "no UI for ingest, local browse or set listing" — is this screen.

`CatalogSourceSummary` gained **`canIngest`** so the panel defaults to a source that can
actually ingest and disables the ones that cannot — before that it defaulted to Scryfall,
whose only possible answer was the "cannot be ingested" error. Driven live: listed 217
Pokémon sets from tcgcsv, ingested `ME: 30th Celebration` (67 created, 1.1 s) through the
browser, and watched the sets table pick it up without a reload.

#### zod 4, and the test that should have existed first (#30)

Dependabot's zod major (#7) had been green since it opened, and **that meant nothing**:
zod has exactly one consumer here — `apps/api/src/config/env.ts`, the boot-time config
validator — and it had **no tests at all**, because every suite sets its own config. The
tests were written first against zod 3, then the upgrade ran.

The worry was zod 4's `.default()` no longer feeding its value through the rest of the
pipeline. Three env vars are booleans derived from strings and **two fail towards less
safety** if that degrades — `ENABLE_QUERY_CONSOLE='false'` and
`OIDC_ALLOW_LOCAL_LOGIN='false'` are truthy _as strings_, and the second leaves the
password door open on an SSO deployment that closed it. It did not bite, because the
transform sits **outside** the default in this chain rather than inside it.

**The assertions are `toBe(false)`, not `toBeFalsy()`, and that is the whole point** —
`Boolean('false')` is `true`, so only an identity check catches a coercion degrading into
a non-empty string. Mutation checked: one `v === 'true'` → `Boolean(v)` fails 8 of 18.

Verified in the real container too: the image boots healthy, the workers start (a real
`true`), the query console reports disabled (a real `false`), and a short
`CREDENTIAL_MASTER_KEY` is still refused at boot.

**Dependabot: 0 security alerts, three non-security PRs left** (checked 2026-08-01) — #6
TypeScript 5→6, #8 ESLint 9→10, #9 `@vitejs/plugin-react` 4→6. All majors, none urgent;
#11's minor-and-patch group has since gone. The lesson from #7 generalises: check what
actually consumes the package before trusting green CI on a bump.

#### The hub's SKU is a composite code, not a bare product id (#32)

`apps/api/src/inventory/sku-code.ts` — `encodeSkuCode` / `parseSkuCode`, pure functions
the way `allocation.ts` and `propose.ts` are, plus a new match reason `hub-sku` ranked
**certain**, and `MatchingService.confirm` now stamps the full code through `listing.sku`.

The 139 SKUs on the live store carry tcgcsv's **product**-level id, which is right for
sealed product and wrong for singles: a card in Near Mint and the same card in Damaged
share that id, so the matcher's `certain` path — an equality test — would equate them.
The code carries `Sku`'s natural key instead, which already has the shape:

```
tcgcsv:662182:NM:1ST_EDITION_HOLOFOIL:EN
```

`<sourceKey>:<sourceId>:<condition>:<printing>:<language>`, **one format for singles and
sealed alike** — sealed is `tcgcsv:704143:SEALED:NORMAL:EN` — because two formats would
mean every reader has to work out which one it is looking at. That was the operator's
call: "do the composite skus for singles and sealed".

- **Edition gets no segment**, deliberately. `printing` already packs edition and finish
  into one composite token, because TCGPlayer's `Condition` column packs the same four
  dimensions into one string and `condition.ts` splits and rebuilds it losslessly. A
  segment of its own would mean changing `Sku`'s natural key to express something already
  expressible.
- **Colons, because the operator's existing seller SKUs are dash-heavy** (`10-10050-122`,
  `UGDSQR######`) — a dash separator could not be told apart from a code someone else
  wrote. A colon appears in none of them. (It does appear in Shopify's search syntax,
  which is what #33's quoting is about.)
- **The parser is strict because it runs on other people's data.** It sees every listing
  SKU in the store, and 434 of the operator's 867 carry a seller SKU with nothing to do
  with this hub. Reading one of those as a code would report `certain` — the one tier
  offered for bulk acceptance — on a guess. It validates **shapes, not vocabularies**, so
  a new language code needs no change here, and it never trims or normalises: a value that
  changes shape between writing and reading turns tomorrow's exact match into a guess.
- **`hub-sku` is checked across every namespace before the embedded-id test, and that
  ordering is load-bearing.** A code contains the bare id, and an ingested item carries
  both a `tcgcsv` and a `tcgplayer` ref holding the same number, so the embedded test is
  genuinely reachable first and would report `probable` for exact evidence. Mutation
  checked twice — disabling the branch, and folding it into the shared loop, each fail the
  ordering test.
- **The code is assembled from the re-fetched candidate and the row `ensureSku` actually
  wrote, never from the request.** `language` is defaulted from the catalogue before `EN`,
  so a code built from the request would name a printing that does not exist — on a
  storefront, where nothing notices until a re-match fails. `ensureSku` now returns the
  dimensions it stored, for that reason.

The payoff beyond matching: `deriveSkuDimensions` reads condition out of the listing
_title_ and returns `undefined` rather than defaulting, because software guessing a card's
condition is software guessing its value. A code carries it as data, so the guess goes.

**All 139 live SKUs now carry these codes** — re-stamped and verified on 2026-07-31, see
below.

#### `listing.create` — a connector may bring a listing into existence (#33)

The connector half of Shopify product creation (open decision 5, now two-thirds built).
A new capability + `Connector.createListing`, `CreateListingRequest` /
`CreateListingResult` in the SDK, and Shopify's implementation.

**A new capability, not a change to `listing.push`.** `pushListing` still refuses to
create and the reason has not changed — a `PushListingRequest` carries no title, image or
vendor, so a connector creating from one would be inventing them. `listing.create` answers
that objection rather than deleting it: the content is an input the operator supplies.

- **One product per card, a variant per condition** — the operator's choice, and the shape
  `Sku`'s natural key already has. So creation is sometimes an _add a variant_, and the
  core names a **sibling variant it already drives** (`siblingListingId`) and lets the
  connector resolve whatever the platform calls the thing above it. The core sends no
  product id because it does not store one, and **should not start**: adding a column to
  express something it can already point at is the wrong trade.
- **Draft is hard-coded, not a request field.** Nothing should become buyable because a
  background job ran, and a parameter is an invitation for some future caller to pass
  `ACTIVE`.
- **No quantity is set at creation.** Stock flows through `listing.quantity` like
  everything else, so there is exactly one code path from the ledger to a platform's
  numbers (rule 5). `inventoryItem.tracked` **is** set, because an untracked variant
  silently ignores every quantity push that follows — a failure that looks like nothing
  happening.
- **Idempotency is a SKU lookup, checked first**, and the equality is re-checked in the
  connector rather than trusted to Shopify's search, which is not an exact-match engine: a
  near-match returned as exact would hand back somebody else's variant to be linked.
- **The SKU must be quoted in that search.** Our codes contain colons and Shopify's search
  syntax uses a colon as its field separator, so unquoted
  `sku:tcgcsv:704143:SEALED:NORMAL:EN` parses as a field named `tcgcsv`, matches nothing,
  reads as "not there", and duplicates the product.
- **CodeQL caught a real `js/incomplete-sanitization`** in the first version of that
  quoting: escaping `"` without `\` lets a value ending in a backslash escape the closing
  quote, and the rest of the query becomes part of the string — which for an idempotency
  check reads as "not there" and duplicates a product. Backslashes first, then quotes, in
  one named helper. Reachable even though a hub code contains neither character, because
  `createListing` takes `sku` as an opaque string and a connector must not assume its
  caller validated anything. **Watch for this in any new search-string building.**
- **Both `productCreate` shapes are handled** — Shopify has changed whether it materialises
  a variant for a declared option, and this connector has already been caught by three
  schema changes in one sitting. It fills in the variant it made, or creates one if it
  made none.

All three GraphQL documents were validated against the live `2026-07` schema with
`validate_graphql_codeblocks` **before** being written into the connector. They need
`read_products` and `write_products`, both already declared — no scope change.

**Nothing has been created on a real store yet**, and the core service, endpoint and UI
that call this do not exist.

#### Creating listings: the core third, and a tag vocabulary (#34)

`apps/api/src/listings/` — `ListingCreationService`, `POST /channels/:id/listings`, and a
`/list` screen. With #32 and #33 this closes open decision 5: the operator can put a card
the store does not carry onto the storefront without creating the product by hand.

- **Selected, never automatic**, which is the operator's own constraint and the first thing
  to preserve. The endpoint takes explicit inventory item ids and is reachable from nothing
  else — not intake, not a push, not a queue. The screen has **no "select all"**: a filter
  narrows what is offered, and only ticked rows are sent. A run over `MAX_ITEMS` (50) is
  **refused, not truncated**, because a partial run of storefront creations is
  indistinguishable from a complete one afterwards.
- **The core decides grouping and nothing else does.** It looks for an allocation on this
  channel for another `Sku` of the same `CatalogItem` and passes that allocation's
  `externalListingId` as `siblingListingId`. **No in-run bookkeeping**: the run is
  sequential and the allocation is recorded before the next item is prepared, so two
  conditions selected together group through the same database read that a second run
  would use. An in-run map was written first and removed — a mutation proved it changed
  nothing, and a second answer to "which product is this" is how the two start to
  disagree.
- **Ordering is the opposite of `confirm`'s, and has to be.** Matching records the link
  before touching the channel; creation cannot, because the id does not exist until the
  platform makes it. A local failure afterwards leaves a draft carrying our SKU with no
  allocation — recoverable **only** because `createListing` is idempotent on the SKU, which
  is why the code is built before anything is created.
- **The `hub:` namespace** (`sku-code.ts`) is what makes a card with no `CatalogExternalRef`
  listable at all — "some won't be listed on TCGPlayer". It carries the `Sku` uuid, never
  matches a catalogue candidate (correctly: there is nothing to match), and still gives
  `deriveSkuDimensions` the condition outright. Reserved; a test pins that no bundled source
  claims it.
- **`pickAttribution` is exported rather than reimplemented**, so the code written to a
  listing carries the attribution a later proposal run will present the item under. Two
  copies of that choice would eventually disagree, and the symptom is a `hub-sku` code on a
  live storefront the matcher no longer recognises as its own.
- **Two composed fields, both from stored facts only.** The title is `name`, plus ` - set`
  where the name does not already contain it — a card's name alone is not a title, because
  Charizard ex exists in several sets. The option value is **`formatCondition`'s** spelling
  ("Near Mint Holofoil - Japanese"), which is not cosmetic: Shopify titles a variant
  `<product> - <option value>` and `deriveSkuDimensions` parses exactly that grammar, so a
  listing whose SKU field is later cleared by hand still says what condition it is. The
  fallback for a SKU TCGPlayer has no spelling for (`NA`, `ETCHED`) is the raw tokens.
- **Creation sets no quantity and invents no price.** Stock follows through
  `listing.quantity` like everything else (rule 5); a price is passed only when the
  allocation already carries one. `upsertAllocation` then enqueues the quantity push by
  itself.
- **The same "already driven by another item" guard `applyLink` has**, and for the same
  reason — reachable here through `alreadyExisted`, when a hand-edited seller SKU sits on a
  listing this hub drives from somewhere else.

**`listing.tags` → `listTags` is a new capability**, and it exists because of the
collections finding below rather than for completeness. Shopify's `productTags` needs only
`read_products` (already declared) and is paginated internally: a partial vocabulary is a
trap, since a tag missing from the list looks exactly like a tag the store does not use.
**Read live on 2026-07-31: 249 tags**, including `Pokémon` and `Magic: The Gathering` —
and no singles tag, exactly as measured. Driving the screen reproduced the trap: adding
`Pokemon` raises "not a tag this store already uses", which is the difference between a
product in a collection and one nobody can find.

#### The 139 live SKUs now carry composite codes, and `certain` has been seen (2026-07-31)

The re-stamp #32 was written for, carried out. **139 of 139 rewritten from a bare product
id to a full code, verified by reading the store back: zero mismatches, every one five
segments.** `565630` is now `tcgcsv:565630:SEALED:NORMAL:EN`.

- **A fresh backup was taken first**, to `private/shopify-sku-backup-2026-07-31T14-43-11.csv`
  (gitignored) — **875 variants, 506 carrying a SKU**, up from 867/434 in July's backup
  because the store has grown and because 139 of those SKUs are ones the hub wrote.
- **One row first, verified, then the batch.** The batch is `POST /match/confirm` with
  `writeSkuToChannel`, built from the database rather than a review screen: every link
  already existed, so all 139 came back `unchanged` with `skuWritten: 139`. 81 seconds,
  which is the connector's own 2/s limit doing its job.
- **Verified by reading the store, not by trusting the report.** A mutation that answers
  200 and changes nothing looks identical from this side.

**The first live `certain` in this project's history**, and the thing all three layers were
for. Proven by detaching one allocation's `externalListingId` locally — the store was not
touched — and re-proposing its set:

```
certain | hub-sku | "Pokémon TCG: Scarlet & Violet Surging Sparks Elite Trainer Box - Default Title"
        | SKU "tcgcsv:565630:SEALED:NORMAL:EN" is this hub's code for the tcgcsv id 565630
        | derived = SEALED / NORMAL / EN
```

Note what `derived` says: the dimensions came **out of the code**, not out of the title.
That is `deriveSkuDimensions` no longer guessing. The link was restored immediately
afterwards and the channel is back to 139.

**Worth knowing before expecting to see this again: `propose` skips listings that are
already linked**, so a code on a listing the hub already drives will never surface in a
normal run. Its value is realised on **re-derivation** — a hub rebuilt from nothing, or a
listing detached and re-matched — which is exactly the scenario `listing.sku` exists for.
The detach above is how to demonstrate it, and it is safe.

#### A product has now been created on the live store, and deleted (2026-07-31)

The whole path run once, end to end, and then cleaned up. **The only unlisted item in the
entire ledger was a leftover `Black Lotus` test row** (Magic Online Promos, NM FOIL, qty 4)
— there are no real singles in the ledger yet, which is worth knowing before planning a
first "real" run.

Created with one tag picked from the store's vocabulary (`Magic: The Gathering`) and vendor
`Wizards of the Coast`. Read back from Shopify, everything the design promised held:

| Claim                              | What the store returned                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| Title composed from ledger fields  | `Black Lotus - Magic Online Promos`                            |
| Draft, never buyable               | `status: DRAFT`                                                |
| Tag and vendor verbatim            | `["Magic: The Gathering"]`, `Wizards of the Coast`             |
| Option from `formatCondition`      | `Condition` = `Near Mint Foil`                                 |
| Tracked, or quantity pushes vanish | `inventoryItem.tracked: true`                                  |
| One variant, not two               | exactly one — `productCreate` made it, `fillVariant` filled it |
| Image from the catalog item        | one `MediaImage`                                               |

Three things only a live run showed:

- **`displayName` came back `Black Lotus - Magic Online Promos - Near Mint Foil`**, and
  that is the round trip working: `splitChannelTitle` takes the tail because it parses as a
  condition, leaving the product name intact. The option value being TCGPlayer's spelling
  is what makes that true.
- **The SKU code fell through to `scryfall`** — `scryfall:b9203f23-…:NM:FOIL:EN` — because
  that item carries only a Scryfall ref. `pickAttribution`'s fallback works, and a uuid
  passes the code's `sourceId` shape.
- **Stock arrived by itself.** Creation set no quantity, `upsertAllocation` queued a push,
  and the outbound worker wrote it: the allocation went to `listedQuantity 4` / `listed`,
  and Shopify reported **available 4** at the pinned location. That is the whole argument
  for rule 5 demonstrated in one run — creation and sync are one code path into a
  platform's numbers, not two.

The product was then deleted through the Admin API and the allocation detached, leaving the
channel back at 139 links. **The hub cannot delete a product**, deliberately, so cleanup
after a smoke test is a manual step — the same shape as the test order that had to be
cancelled by hand.

#### Metafields on created cards — `custom.game`, `custom.set` and the rest (2026-07-31)

The operator asked for game, set and similar fields on created cards. **The store already
models them**, which changes the job from "design some fields" into "write into what is
there". Measured live, and none of it is guessable:

| Field                            | Type                        | On  |
| -------------------------------- | --------------------------- | --- |
| `custom.game`                    | `metaobject_reference`      | 434 |
| `custom.set`                     | `metaobject_reference`      | 142 |
| `shopify.rarity`                 | `list.metaobject_reference` | 18  |
| `shopify.card-attributes`        | `list.metaobject_reference` | 31  |
| `shopify.trading-card-packaging` | `list.metaobject_reference` | 58  |
| `shopify.condition`              | `list.metaobject_reference` | 2   |

- **They are metaobject _references_, not text.** The value is a GID —
  `custom.game` is `gid://shopify/Metaobject/141624803381` on every Pokémon product — which
  means nothing outside this one shop. So the same rule as tags applies, harder: the hub
  can carry a value the operator picked and must never derive one.
- **Variant level has nothing** but eleven `mm-google-shopping` fields. There is no
  existing home for condition/printing/language on a variant, and the `Condition` option
  plus the SKU code already carry those, so nothing is proposed there.
- **A definition's vocabulary is found through `validations`**, which give a
  `metaobject_definition_id` — not a type string, so `metaobjects(type:)` cannot be reached
  from a definition without a second lookup.
- **`ProductCreateInput` and `ProductVariantsBulkInput` both accept `metafields`**, verified
  against the live `2026-07` schema, so creation needs no extra round trip.

**Built as `listing.metafields` → `listMetafields`, plus `CreateListingRequest.metafields`
and a picker on `/list`.** Values are opaque to the core and applied verbatim, exactly like
tags — it could not derive one even if it wanted to.

**One scope, and only one: `read_metaobjects`.** `read_metaobject_definitions` looked
necessary because a metafield definition names its vocabulary as a
`metaobject_definition_id` rather than a type string, and turning that into the `type` that
`metaobjects()` wants needs the definitions scope. It is not needed: the type can be read
off **a product that already carries the field** (`metafield { reference { type } }`), which
`read_metaobjects` covers. Live, `custom.game` resolves to type `game` and `custom.set` to
`set`.

**Discovery is two passes, because neither is complete on its own — both measured, not
guessed:**

1. **Ask for each field by name**, `products(first: 1, query: "metafields.<ns>.<key>:*")`,
   all of them aliased into one request. Precise, and it finds `shopify.rarity` — on 18 of
   875 products.
2. **Then sweep recent products** for anything the filter did not match. Necessary because
   `metafields.shopify.color-pattern:*` returns **nothing** on a shop where 30 products
   carry that field. The filter is precise but not exhaustive; the sweep is exhaustive but
   lucky.

The first version was the sweep alone, and it silently reported `shopify.rarity` — a field
in real use — as one nobody uses. The sweep only runs when something is still unresolved.

**The trap this design exists for:** without the scope Shopify answers **`null` with no
error**, indistinguishable from a store that has defined no entries. So
`ListingMetafieldDefinition` carries an explicit `unavailable` reason, never an empty
`choices`, and a caller shown "unavailable" can name the scope while one shown an empty
list would conclude the store has nothing.

**Getting the scope granted took three attempts and cost real time**, all of it the same
"releasing is not installing" rule recorded above: two releases were cut and freshly minted
tokens still reported the old four scopes. The Dev Dashboard would not offer the store for
re-install either. It took an uninstall and a fresh install to land.

**Live, through the hub, in 2 seconds:** 40 definitions, of which the 6 in real use all
resolve — `custom.game` 18 entries, `custom.set` 35, `shopify.rarity` 4,
`shopify.card-attributes` 2, `shopify.trading-card-packaging` 4, `shopify.color-pattern` 30. The other 34 are defined and unused, and are reported as unresolved rather than empty.

**Picked per run, not per card**, and that is a property of the data rather than a
shortcut: the values are ids in the store's vocabulary, so nothing could derive one per
card. A run is one set's worth of cards, the same scope a proposal run has. `custom.set`'s
entries are spelled `ME02 Phantasmal Flames` — the **tag** spelling, not tcgcsv's
`ME02: Phantasmal Flames` — which is the third independent confirmation that catalogue
names are not this store's vocabulary.

**Product-owned fields are set only when a product is created.** Adding a variant to a
product the operator already curated must not rewrite that product's description of
itself.

#### Conditional metafields need a category, and Shopify will not say so (2026-08-01)

The first real attempt to set `custom.game` and `custom.set` **failed on all three items,
creating nothing**, with:

> Owner subtype does not match the metafield definition's constraints.

That message names neither the field nor the cause. The cause: **almost every metafield
definition on this store is _conditional_** — restricted to a product category. `custom.game`
and `custom.set` apply only to `ae-2-2-3-2` ("Gaming Cards"); `shopify.rarity` to ten
categories; only the Google and discovery ones are unrestricted. Every existing product
carries a category and a newly created one carries none, so it satisfies no constraint at
all.

- **`ListingMetafieldDefinition.requiresCategory`** reports them, read from
  `metafieldDefinitions.constraints`. Names come from the taxonomy in one aliased request,
  because a constraint yields only `ae-2-2-3-2` and that tells an operator nothing.
- **`CreateListingRequest.category`** carries the answer back, verbatim and opaque, exactly
  like a metafield value. `toTaxonomyGid` normalises the bare handle a constraint gives
  into the GID `productCreate` wants, so the core never learns either spelling.
- **The screen does not ask when it does not have to.** It intersects the categories the
  chosen fields require: one in common — the usual case — is applied silently and stated;
  several offers a picker limited to those; **none is an error**, because two fields that
  share no category cannot both apply to one product and the run would fail whatever was
  picked.
- **The connector explains the rejection** rather than passing it through bare, but only in
  the case that accounts for it — metafields sent, no category set. Two tests pin both
  directions, because a hint that fires when the category _was_ set would send the next
  person down the wrong path.

**Proven live.** One product, three variants, `category: Gaming Cards`,
`custom.game: Pokémon`, `custom.set: ME02 Phantasmal Flames`, read back through the
references.

Two things the first live creations exposed, both now settled by the operator:

- **Sealed product gets no variant option at all** — their call. Creation had given it
  `Condition: Unopened`, while every sealed product the store sells is a single-variant
  `Default Title`; an option with one answer is a choice put in front of a customer for no
  reason. **`NA` is treated the same way**, by its own definition — "not applicable" is
  what a binder, a playmat or a Funko Pop has, and `Condition: NA` on a storefront is the
  same silliness one step on. `UNVARIED_CONDITIONS` is the list.

  **It follows that such an item is never a _variant_ of anything either**, so no sibling
  is looked for. Two sealed SKUs of one catalogue product — an English box and a Japanese
  one — become two products, which is what a store carrying both wants; the alternative is
  a second variant on a product with no option to tell them apart. Mutation-checked: both
  halves fail their tests when the rule is disabled.

- **The set is appended for singles and not for sealed** — the same split as the option,
  and settled in two steps rather than one. Appending it everywhere produced "Phantasmal
  Flames Pokemon Center Elite Trainer Box (Exclusive) - ME02: Phantasmal Flames": the
  containment check does not fire, because the name holds `Phantasmal Flames` while the
  catalogue spells the set `ME02: Phantasmal Flames`. Dropping it everywhere then left
  every printing of "Charizard ex" as an identically titled product. The split is right
  because the two cases differ in fact — **a sealed product's name already carries its set
  and a single's does not.** `titleFor` takes the flag from the caller rather than
  re-deriving it, so the title and the variant option can never disagree about what an item
  is.

#### Multi-variant products are mapped, never created (measured 2026-08-01)

**69 of the store's 696 products carry more than one variant**, and not one of them uses
condition as the axis: it is `Promo` (blisters with different promo cards), `Deck`,
`Scene`, `Colour`, `Type`, `Eeveelution`. The hub models none of those and could not invent
them, so **creation will never reproduce that shape** — a card's conditions are the only
variant axis it knows.

That is not a gap, because the other path already covers it. **7 of the 139 live links
already point at variants of multi-variant products** — two promos of "Perfect Order
Premium Checklane Blister" and all five of "MTG Final Fantasy Scene Box" — each carrying
its own hub SKU code. `enumerateListings` walks _variants_, so every variant of a
multi-variant product appears as its own listing and links to its own inventory item.
Matching and creation are separate paths and the sealed rule touches only the second.

Worth knowing about the shape of that data: **tcgcsv models each promo as its own product**
(`tcgcsv:672409` Clawitzer, `tcgcsv:672407` Cinderace), while the store models them as two
variants of one. Both are right; the hub's grouping is by `CatalogItem`, so it would have
created them as two products even before the sealed rule. The store's arrangement is the
operator's, and mapping is how the two meet.

Also confirmed here: the 1-Pack blisters are **separate single-variant products**, and
`[Drifloon]` and `[Drifblim]` still share seller SKU `10-10053-110` — the old non-unique
scheme, exactly as recorded. Where the hub has re-stamped, the ambiguity is gone: the
Psyduck and Golduck 3-packs now hold `tcgcsv:644357` and `tcgcsv:644356`.

#### Collector numbers in a title: free for Pokémon, a migration for anything else

Asked 2026-08-01, after the first real singles went into the ledger. The operator wants
the number in a created product's title so it is searchable.

**Pokémon already has it and needs no code at all**, because tcgcsv puts the number in the
product name: `Mega Charizard X ex - 013/094`. With the set appended the title reads
"Mega Charizard X ex - 013/094 - ME02: Phantasmal Flames". Magic and One Piece names carry
no number — `Mabel, Heir to Cragflame`, `Nami` — so theirs cannot.

**Doing it for the others is not a small change**, which is worth writing down because the
data looks tantalisingly close to hand. `TcgcsvProductRow.extended.extNumber` is parsed and
sits right there, and every layer above drops it:

| Layer              | Holds a number?                                  |
| ------------------ | ------------------------------------------------ |
| `TcgcsvProductRow` | **yes**, `extended.extNumber`                    |
| `toCandidates`     | no — `extended` is not copied onto the candidate |
| `CatalogCandidate` | no field                                         |
| `CatalogItem`      | no column                                        |

So it is an SDK field, a tcgcsv change, **a schema migration** (dialect-neutral, rule 2),
intake and ingest plumbing, `titleFor`, and a re-ingest to backfill the ~1,100 items
already stored. An hour or so, not a line. Deferred on the operator's own instruction —
"let's not spend a lot of time on it now if it's not something very simple".

Note if it is ever picked up: **some One Piece names already carry a parenthesised number**
(`Donquixote Doflamingo (060)`) but only where tcgcsv needed to disambiguate a repeated
name, so it is not a substitute for the real field.

#### Non-TCG goods need no "other" mode — the ledger already holds them

Asked 2026-08-01, and the answer is that nothing needs building. Three things were already
true and are worth stating so nobody adds a parallel path for them:

- **`CatalogItem.game` is nullable**, and the schema comment has said "null for non-TCG
  goods" since Phase 0.
- **`SKU_CONDITIONS` includes `NA`**, meaning "not applicable" — the condition a playmat or
  a Funko Pop has. It now also means "no variant option", above.
- **`POST /inventory` creates a ledger item from a name alone** — game and set optional, no
  catalogue lookup — and the `/intake` screen exposes it. That is the "other" option.

Creation works for them too, because a ledger item with no `CatalogExternalRef` still gets
a valid identifier: `hub:<skuId>:NA:NORMAL:EN`. And this is not hypothetical — the
operator's own TCGPlayer export already round-trips sleeves, deck boxes and playmats across
21 product lines.

**A future Funko connector needs no core change either.** Nothing in the model is
TCG-specific: a catalogue that knows Funko Pops is a `CatalogSource`, a marketplace that
sells them is a `Connector`, and `Sku`'s natural key degrades gracefully to
`NA / NORMAL / EN`. The one TCG-shaped seam is `optionValueFor`, which borrows TCGPlayer's
condition vocabulary — and it already falls back to raw tokens for anything that vocabulary
cannot spell.

#### How the store's collections actually work (measured 2026-07-31)

Not code, but it decides what a created product must carry, and getting it wrong is
invisible rather than loud.

- **All 23 collections are smart collections on a single TAG equality rule.** A tag is the
  only thing that puts a product in front of a customer. A product with the wrong tags
  exists in the admin and appears nowhere in the shop.
- **Catalogue names are not the store's tags.** tcgcsv says `Pokemon`, the rule wants
  `Pokémon`; tcgcsv says `Magic`, the tag is `Magic: The Gathering`. Set tags are _usually_
  the tcgcsv name minus the colon (`SV04: Paradox Rift` → `SV04 Paradox Rift`) — but
  `SV: Prismatic Evolutions` exists as **both** `SV085 Prismatic Evolutions` and
  `SV85 Prismatic Evolutions`.
- **So the hub must never derive a tag.** `CreateListingRequest.tags` is applied verbatim
  and only when given; the operator picks from the store's real vocabulary
  (`productTags`), pre-filled with a guess, and blank means no tags. That subsumes the
  alternatives, which is why it was chosen over a formal question.
- `vendor` is the publisher, `productType` is unused, and tags follow kind / game / set
  (`Booster Pack`, `Pokémon`, `SV04 Paradox Rift`). **No singles tag exists yet** — singles
  are new ground for this store.

#### The UI got its first real use, and it was full of holes (#44)

The operator drove the app for the first time instead of reading about it, and
almost everything they hit was a defect rather than a preference. **Screenshot a
layout complaint** — every one of these had been invisible because the pages had
only ever been read through an accessibility tree, which reports the structure
the markup implies rather than the layout the CSS produces.

- **A bare `form { flex-direction: column }` was overriding `.filters`**, which
  sets display, gap and wrap but never direction. So `<form class="filters">`
  stretched every control full width, one per line, while identical markup in a
  `<div>` laid out as a row — two screens looking unrelated for no visible
  reason. `.filters` now states its direction.
- **`.cell-title` / `.cell-sub` only stacked by accident**, via `.cell-link`
  happening to be a flex column. In a plain `<td>` — match, catalog and listing
  screens — they ran together as "151 Booster BundleSV: Scarlet & Violet 151",
  which reads as bad data rather than a missing style.
- **The intake screen's Game field never rendered.** It was a `<select>` shown
  only when the registered sources between them declared more than one game, and
  they do not: Scryfall declares Magic, tcgcsv declares none. So the field
  vanished — and tcgcsv, which _refuses to search without a game_, could not be
  given one. That is why every intake search reported it unavailable. Free text
  with suggestions now, the same shape as the match screen's game field.
- **A drifted CSRF cookie was unrecoverable.** It is set once at login, so a
  browser holding a token from an earlier session fails every mutation with 403
  while every read succeeds — which reads as a broken feature. `/auth/me` now
  re-issues it from the session that just authenticated, so a refresh repairs
  it. Safe: the value is already in a cookie that browser holds, and a
  cross-origin caller can read neither the response nor the cookie it sets.
- **The item detail page never said what the item was**, because
  `GET /inventory/:id` returned `getLedger` — allocations and quantities and
  nothing else. `getItemDetail` adds the identity and the external ids. The
  trap worth remembering: the detail cache is written from mutation responses,
  and a mutation answers with the _ledger_, so writing it straight in blanked
  the name and image the moment anyone adjusted a quantity. It merges now.

Three things the operator asked for, all of which the API already supported and
the browser simply never offered: **rows per page** (a fixed set, since the
value reaches a `take`), **a channel filter** (including "on no channel", which
is the question behind "what have I not listed yet" and needed
`allocations: { none: {} }`), and **a game filter** with counts from
`GET /inventory/games` — derived from what is held rather than what sources
declare, because a filter offering an option that returns nothing is worse than
one with fewer options. A null game is a real bucket and appears when anything
is in it: that is the generic answer for non-TCG goods, rather than renaming the
column.

Optional card art is remembered in `localStorage` rather than the URL — it is a
preference about how someone reads the table, not part of what the table shows,
so it must not travel when a filtered view is shared.

### v0.3.0 (2026-08-02)

Tagged at `728f417` (PR #46). Multi-arch image at
`ghcr.io/collectorscampus/multi-channel-inventory-hub`, tagged `0.3.0`, `0.3` and `latest` —
all three at digest `sha256:0ccf660e…`, replacing v0.2.0's `sha256:60c34127…`. The build took
**~4 minutes**, warm cache again. Everything from #21 to #45 is in it. No schema change: the
four migrations are unchanged since 0.1.0.

Verified the way v0.1.1 established — anonymous registry token first, then boot the published
image and look inside it, never trust the report:

- **Anonymously**, the tag list returns all eight tags and the `0.3.0` index resolves to real
  `linux/amd64` and `linux/arm64` children (plus the two attestation manifests, which is why a
  naive filter on `platform.architecture` finds nothing useful).
- **The image reports its own version.** `/api/docs/openapi.json` says `info.version: 0.3.0`,
  read from `apps/api/package.json` rather than repeated — which is the version unification
  proven in the artifact rather than asserted in a manifest. 43 paths, including
  `/api/channels/{id}/listings`, `/listings/tags`, `/listings/metafields` and
  `/api/catalog/local/{sets,search}`.
- **The bundle it serves is the one built here** — `/assets/index-B0BIx4bM.js`, 409,792 bytes,
  the exact hash the local `vite build` produced, and `application/javascript; charset=utf-8`.
  Still the only place `@fastify/static` 10's permanently unmet peer is actually proven.
- **`--prod` still holds**: zero `vite`, `vitest` or `esbuild` in the runtime tree. The 0.1.1
  pins survive — one `@fastify+static@10.1.2`, one `find-my-way@9.7.0`, `js-yaml@5.2.2` — and
  `zod@4.4.3` confirms #30 shipped.

Two things worth not re-deriving:

- **`gh api --input` with a UTF-8 JSON file is the right way to create the Release**, and it
  handles an em dash in the **title** — which `gh --title` from bash does not. Build the
  payload with `ConvertTo-Json` and write it with `UTF8Encoding($false)`.
- **In PowerShell, `Invoke-WebRequest`'s `.Content` is a byte array for some content types and
  a string for others**, so a verification script that assumes either will fail confusingly on
  the other. Registry manifests came back as bytes, the SPA index as a string.

Expect the stale-job churn again if you boot it against the **test** Redis on 6380: a minute
of `Allocation … no longer exists` warnings for jobs the test suites left behind. Harmless,
documented under v0.1.1, and still alarming to read.

### After v0.3.0 — PRs #48–#50 (2026-08-02), on `main`, in no released image

The operator's own framing: "getting something useful and stable for me to use for my
business", with the core loop first — cards into the ledger, cards onto Shopify.

#### An outbound push happened once per allocation, then never again (#48)

**The worst bug found in this project so far, and it was in every released image
including the v0.3.0 tagged the same day.** Present since Phase 3 (`c83e59d`,
2026-07-28).

`OutboundQueue.enqueue` reuses one job id per allocation and operation so a burst of
edits collapses into a single job. BullMQ enforces that by refusing `add` for an id it
already holds — **including one sitting in the completed set**, which `removeOnComplete:
{ count: 500 }` retained. So the first successful push for an allocation permanently
poisoned its id: every later change was accepted by `enqueue`, logged `Queued`, and
silently discarded until 500 more completions on that queue happened to evict it.

The failure shape is the worst available: **a storefront that syncs once and then quietly
never again.** No error, no failed job, nothing in the alert inbox, and `SyncEvent` shows
the one push that did work.

- **Found by driving the live store, not by a test.** A quantity was pushed, the revert
  was queued, and it never left the building. Confirmed in Redis: the job hash still
  carried the _first_ push's timestamp with `wait` and `active` both empty.
- **`removeOnComplete: true`** frees the id the moment a push succeeds. Burst collapsing
  is untouched, because it only ever needed to dedupe jobs that are pending or running.
  The new test fails without it (`expected +0 to be 1`).
- **Inbound and reconcile are correct and were checked.** Inbound's job id is a
  `WebhookEvent` row id — unique per delivery, and retention there **is** the redelivery
  dedup. Reconcile's per-channel path passes no custom id. The distinction worth keeping:
  whether the id names a **unique event** or a **thing that changes repeatedly**.
- One narrow race survives and is inherent to collapsing: a change landing while a job is
  _active_ is collapsed into a job that has already read state. Milliseconds rather than
  forever, and reconciliation exists to catch it. Seen once during verification.

#### Intake and listing in one step, with per-channel defaults (#48)

`POST /channels/:id/listings/intake`, and a "List on" choice on the intake screen.

- **`ChannelInstance.autoListNewStock` + `listingDefaults`** (one migration, two columns;
  the defaults are a JSON-encoded `String`, the same choice `config` makes and for the
  same reason — nothing ever queries into them). `channels/listing-defaults.ts` is pure
  functions with its own tests, the way `sku-code.ts` is.
- **The toggle is refused until something is declared.** Automatic creation with nothing
  declared puts untagged drafts on a storefront at the speed of intake, and on a
  tag-driven store an untagged product is in no collection — invisible in the shop,
  reported by nothing. The gate is "has the operator answered", **not** "has tags":
  requiring tags would be the hub deciding every store organises by tag, and `{tags: []}`
  is a deliberate answer.
- **Only `undefined` falls back.** An explicit empty list is that run's answer and must
  reach the channel unchanged, or "no tags, just this once" becomes inexpressible.
- **The defaults are one fixed set applied to every card**, so the intake hint _names the
  actual tags_ rather than describing them — a Magic card added while the channel says
  Pokémon lands in the wrong collection. A mixed batch still belongs on `/list`.
- **Intake wins.** The two halves are not atomic and the order is deliberate: a listing
  failure is reported, never rolled back. Stock on the shelf is a fact; whether Shopify
  accepted a draft is not.
- Bulk file imports deliberately do **not** come through here — the 1,333-row rule is
  untouched.

#### Users, settings, and an account menu (#49)

There was no user management **at all**: `auth` had login, logout, me, setup and
change-password. Adding a colleague meant an `INSERT`.

- **Two lock-out rules, both refused rather than warned about**, because there is no undo
  and the only recovery is a database edit. You cannot demote, deactivate or delete
  _yourself_; and the **last active admin** is untouchable by anyone, counted at the moment
  of the change. Two admins demoting each other in sequence is otherwise a pair of legal
  requests ending with nobody in charge. A deactivated admin does not count as cover.
  Neither belongs in a guard: the caller **is** authorised, the _outcome_ is refused.
- **A provisioned identity is never given a local password** — `LocalAuthProvider` refuses
  to authenticate one, so it would be a credential that looks real and can never work.
- The password rule moved to `auth/password-policy.ts`, shared by all three paths that set
  one. Three copies drift silently: an account created through one path that another would
  have refused.
- **Deactivation needs no session sweep** — `SessionService.resolve` and
  `ApiKeyService.resolve` both check `isActive` on the joined user, so it bites on the next
  request. An admin _password reset_ does revoke sessions, because it usually answers a
  compromise.
- Settings reports the deployment **read-only**: `AUTH_PROVIDER` and the query console are
  read from the environment at boot, so a form would either lie or imply a restart nobody
  expects. Per-channel settings stay on the channel — which is where `listingDefaults`
  finally got a UI.
- **Developer mode** reveals `/match` and `/list` in the nav. A preference, not a
  permission: the routes are guarded server-side and typing the path always worked.

#### The allocation editor (#50)

Reported as "just very confusing", and it was, concretely: **adding a channel meant typing
its UUID by hand** — findable nowhere in the UI — beside a hint promising channel
configuration "in Phase 3", which had shipped months earlier. Each row was then headed
with that UUID, so the one question the panel exists to answer was the one thing it never
said. The first control offered "fixed — exclusive partition" / "pooled — mirrors the
pool", the price had no currency, and nothing said whether a listing was attached.

Now: the channel's name, a price with its currency, Save. Modes sit behind an **Advanced**
disclosure phrased as what they do to the number a customer sees. Adding a channel is a
dropdown minus the ones the item is already on. **No engine change** — it still posts
whole allocations and validates through `/preview`.

#### Three things only driving it revealed

- **The dev-mode toggle did nothing to the nav.** `AppShell` and the settings page each
  called `useDevMode` and each got its own `useState`; the `storage` event deliberately
  does not fire in the tab that caused it. Now one module-level store via
  `useSyncExternalStore`. **Any preference read in two places needs this shape.**
- **A `datalist` spends Enter on accepting the highlighted suggestion**, so a tag input
  relying on Enter alone added nothing when a tag was picked from the dropdown. An explicit
  button is required; Enter is a shortcut.
- **Both of the operator's channels are called "Collector's Campus"** — their own business
  name, the obvious thing to type twice. A display name alone is not an identifier in the
  UI. The connector is appended where the two are ambiguous.

**Screenshots were unavailable for most of this session** (the Browser pane was not
displayed), so layout was checked with `getComputedStyle` and bounding boxes instead —
grid columns, flex gaps, wrap behaviour, horizontal overflow. That catches the same class
of bug the screenshot rule exists for, and is worth knowing as a fallback.

**Verification touched the live store and was put back.** A push moved one variant 0 → 2
and it was returned to 0, confirmed by reading Shopify directly. Channel listing defaults
were set, exercised, and cleared. A test user was created through the form and deleted.

**The queue fix went out in v0.4.0**, not the v0.3.1 planned here — by the time it reached a
release it had a migration and five features beside it. Until then, anyone pulling `latest`
had a hub whose sync stopped after one push per allocation.

### v0.4.0 (2026-08-03) — and the dependency decisions behind it

Tagged at `783540f` (#59). Multi-arch image at
`ghcr.io/collectorscampus/multi-channel-inventory-hub`, tagged `0.4.0`, `0.4` and `latest` —
all at digest `sha256:d6a040cd…`, replacing v0.3.0's `sha256:0ccf660e…`. The build took
**11m27s**, the slowest since v0.1.0: the fastify and eslint bumps invalidated the arm64
layer cache, so a dependency refresh in the same release costs roughly double.

Everything from #48 to #58. The headline is the outbound-queue fix, which had been in
**every published image since 0.1.0**.

Verified anonymously, then inside the artifact — and here the inside check earned its keep
twice over. `removeOnComplete: true` is present in the built
`outbound-queue.service.js`, so the fix genuinely shipped rather than merely being on
`main`; and there is exactly **one** `fastify@5.11.0`, proving the `pnpm.overrides` entry
survived the `--prod` install rather than only working in the dev tree — which is the same
thing the `find-my-way` note warns about. `jose@6.2.7`, `find-my-way@9.7.0` and
`js-yaml@5.2.2` intact, zero `vite`/`vitest`/`esbuild`, and the booted image reports
`info.version: 0.4.0` with `/api/users` and `/api/channels/{id}/listings/intake` in its own
OpenAPI document.

**Dependabot was cleared first: five open PRs, zero security alerts.** Three taken, two
refused, and the reasoning is worth keeping because it is the same three traps each time.

- **fastify 5.11 needed an `overrides` entry, not a bump.** The minor-and-patch group
  _failed the build_ — `FastifyCookie` not assignable to `FastifyPluginCallback` — because
  bumping fastify left **two copies** installed: `@nestjs/platform-fastify` resolves its own
  5.10.0, so the plugin's types bound to a different `FastifyInstance` than `app.register`
  came from. Third time this repo has hit the two-copies shape, after `find-my-way` and
  `js-yaml`; `pnpm.overrides` now carries `fastify@5` beside them. Verified by the lockfile
  no longer mentioning 5.10.0, not by the update running.
- **`@eslint/js` is not versioned with `eslint`** — latest 10.0.1 against eslint 10.8.0 — so
  bumping both to `^10.8.0` resolves nothing and silently leaves eslint at 9.
- **eslint 10's `preserve-caught-error` found two real defects**, both rethrowing without
  `cause`. And the guard that matters was checked directly rather than inferred from green
  lint: a throwaway file calling `prisma.$queryRaw` still fails the raw-SQL ban (rule 1).
  **Do this on every eslint upgrade** — that rule is why the MySQL/SQLite targets stay
  possible, and it would have gone quiet without a word.
- **`@types/node` follows the runtime, not the registry.** Dependabot's 22 → 26 passed CI and
  is still wrong: the Dockerfile pins `node:24`, so types for Node 26 describe APIs that are
  not there and code compiles then fails at run time. Aligned to the **24** line, which also
  fixed types that were already _behind_ the runtime.

**Refused, and now on `dependabot.yml`'s ignore list so they stop reopening weekly:**
`@vitejs/plugin-react` 6 needs `vite ^8`, two majors past what is here and Vite majors are
already ignored; and **typescript 6**, which fails on config rather than code —
`moduleResolution: "Node"` is deprecated, and fixing it properly means every package's
tsconfig plus a `module: Node16` switch that changes the CommonJS emit `packages/db`'s own
comment says the NestJS boundary depends on. Both are real work someone should do
deliberately; neither is urgent, and a security update overrides an ignore rule anyway.

#### README screenshots, and which screens must never be in one (#67)

Six captures of the running app, in `docs/screenshots/`, taken with playwright-core driving
installed Chrome against the local instance. Two things worth not re-deriving:

- **Two screens are excluded on disclosure grounds, and the rule is durable.**
  **Settings/Users displays a real email address**, and the Shopify channel's _edit_ form
  holds the shop domain and the client id — so channels is captured **collapsed**, which is
  where the tag rules are anyway. This is the same rule as "never put a real shop domain in
  a tracked file", and a screenshot is a tracked file. The operator's business name does
  appear and is fine: it is already the repository owner's.
- **Downscaling a 2× UI capture to 1× makes the PNG _bigger_.** Measured, not guessed:
  catalog went 49 kB → 118 kB, channels 88 kB → 175 kB. Bicubic resampling invents
  intermediate colours that PNG then cannot compress, while a crisp 2× capture of flat UI
  has very few. So the naive optimisation is a pessimisation — keep Chrome's output
  untouched. The exception is the card viewer, which is dominated by photographic art:
  there PNG is the wrong codec and JPEG at q88 took 1.6 MB to 420 kB.

The design-document **PDFs were deleted** rather than moved into `docs/` (#67). Nothing
referenced them, `docs/TECHNICAL_DESIGN.md` is what every §-reference points at, and a
non-diffable snapshot of a design the ADRs partly overrule is an invitation to read the
wrong one. `a49b0d1` still has them.

#### Two more advisories, and the reachability rule paying off twice (#68, #69)

Both cleared the same day they appeared; **Dependabot is back to 0 open, 21 fixed**.

- **`brace-expansion` < 1.1.17** (high, OOM via unbounded expansion). Reached 1.1.16 through
  `minimatch@3.1.5` under `fork-ts-checker-webpack-plugin` — a **build-time** type checker,
  so not in the runtime image. Dependabot labelled it `runtime`; that label describes the
  manifest, not reachability. Needed an override, scoped `brace-expansion@1` so the
  unrelated 5.x line is untouched.
- **`fast-uri`** (high, host confusion: `\\evil.com/path` folds into the path because
  fast-uri needs a literal `//`, while WHATWG `URL` treats `\` as `/`). **This one _is_ in
  the runtime image**, via `ajv` and `fast-json-stringify` under Fastify — so the question
  was worth answering properly. The precondition still fails: the only host-based policy
  here is OIDC endpoint pinning, and `discovery.ts` builds its origins with `new URL()`, the
  same parser the following `fetch()` uses. Nothing to desync.
- **No override for `fast-uri`, deliberately.** `ajv` declares `^3.0.1` and
  `fast-json-stringify` `^4.0.0` — **ranges**, not the exact pins that forced the
  `find-my-way` and `js-yaml` overrides — so `pnpm update fast-uri -r` moved both. Check the
  parent's declared range before reaching for an override; one that was never needed still
  has to be carried forever.

### CardTrader as a catalog source — pull-only, built and proven live (2026-08-05)

`packages/catalog-cardtrader` — CardTrader's catalogue as a `CatalogSource`, the pull
side only. **No `Connector`**: selling through CardTrader is still gated on the three
questions in `docs/CONNECTOR_ROADMAP.md` (does `products/export` satisfy
`listing.enumerate`, the real order-webhook body, blueprint→`CatalogItem` match quality),
and none is touched here. **Merged as #77** (2026-08-05), together with the earlier doc-only
commit recording the first API probe.

**The point of building it, proven end to end against the operator's real DB.** A CardTrader
blueprint publishes its own `tcg_player_id`, `scryfall_id` and `card_market_ids`, so an
ingest converges on the existing local catalog through `CatalogExternalRef` **by design**
rather than by the luck of two sources both happening to emit `tcgplayer`. Measured live:
ingesting Phantasmal Flames (CardTrader expansion 4318, 156 blueprints) reported **13
created, 143 refreshed, 0 problems** — the 143 matched existing tcgcsv-created items by
`tcgplayer` id, and `catalog_items` grew by exactly 13, not 156. The Mega Charizard X ex
item (keyed on `tcgplayer:662182` from tcgcsv) ended with **four refs on one row** —
`cardmarket`, `cardtrader`, `tcgcsv`, `tcgplayer` — no duplicate. tcgplayer coverage on that
set was 92%, exactly the doc-commit figure.

**The first catalog source needing credentials, and the plumbing that unblocked it.**
`CatalogService.makeCtx` and `CatalogIngestService.makeCtx` hardcoded `secrets: {}` from the
day `CatalogCtx.secrets` was written. `CatalogCredentialsService` now loads them, keyed on
`catalog:<sourceKey>` in the existing AES-GCM `CredentialStore` — **no migration**, because
`Credential.ref` is a free unique string and the ref is bound in as AEAD associated data, so
CardTrader gets the same "can't move one source's ciphertext onto another" protection
channels get. `makeCtx` became async on both services (the registry's `search` callback now
accepts a `Promise<CatalogCtx>`); the ingest and catalog service constructors gained the
credentials service as a third arg — the only reason the DB-backed specs needed touching.
Admin endpoints `GET`/`PUT /catalog/sources/:key/credentials` report which fields are set
(never values) and store merged, mirroring `ChannelsService`. `CatalogSourceSummary` gained
`secretFields` so the `/catalog` ingest panel shows a token box for a source that declares
one; it is registered and searchable with no token and fails with a clear "requires a token"
the moment it actually calls the API.

Facts worth not re-deriving:

- **Envelope shapes differ by endpoint, measured not assumed.** `/games` and `/categories`
  wrap in `{ array: [...] }`; `/expansions` and `/blueprints/export` are bare arrays. Handled
  explicitly per endpoint so a real shape change fails loudly rather than silently finding
  nothing.
- **Same "importer wearing a search interface" shape as tcgcsv.** No blueprint search
  endpoint and no `GET /blueprints/:id`, so `search()` narrows to ≤4 expansions and
  downloads them, an unscoped query throws, and `fetchById` only resolves a blueprint from
  an expansion already read (an in-memory `blueprintIndex`, like tcgcsv's `productIndex`).
- **No price, ever, and no `printings`.** `/blueprints/export` carries no price — pricing is
  on `/marketplace/products`, a listing endpoint, not a catalogue one. Finish is a set of
  independent per-game booleans (`mtg_foil`, `first_edition`) with no shared vocabulary to
  normalise, so nothing is guessed. `version` (e.g. "Holo Rare | 1/102") is folded into the
  name the way tcgcsv folds a collector number in.
- **No User-Agent gating** — unlike tcgcsv, a bare `fetch` is not 401'd, so no UA dance.
- **CardTrader spells sets without the tcgcsv prefix** — "Phantasmal Flames" vs tcgcsv's
  "ME02: Phantasmal Flames". Harmless for convergence (that runs on `tcgplayer` id), but it
  drives the finding below.
- **`/info` returns the app's `shared_secret`** (webhook signing key). Treat that response
  as a credential if the connector half is ever built; it must never reach a log or a
  tracked file. The token lives only in `private/cardtrader/`.

**The finding a second ingesting source exposed, now fixed: refresh was overwrite, it is
now fill-empty-only.** Ingest calls `ensureCatalogItem(candidate, { refresh: true })`, and
`refreshCatalogItem` used to rewrite `name`/`game`/`setName`/`imageUrl` whenever they
differed. That was invisible while tcgcsv was the _only_ ingesting source (scryfall has no
`listSets`/`fetchSet`). CardTrader is the first second one, and in the live run below its
ingest silently rewrote all 143 converged items' names to CardTrader's spelling **and their
`setName` from "ME02: Phantasmal Flames" to "Phantasmal Flames"** — including 10 with live
SKUs. Set names are case-sensitive and drive matching and the operator's tag collections, so
last-ingest-wins is not acceptable. **The operator chose fill-empty-only**, now implemented:
`refreshCatalogItem` fills a `game`/`setName`/`imageUrl` only where the stored value is blank
and never overwrites a non-empty one. There is no per-field provenance, so the rule is simply
"any non-empty value wins" — which makes `name` immutable after creation (a created item
always has one), so nothing relabels the catalogue behind the operator, while a genuinely
empty field is still backfilled as a pure improvement. Pinned by two DB tests (a changed name
is not applied; a previously-null `setName` is filled).

**The live run was fully rolled back.** The operator's compose DB (`inventory-hub-postgres-1`)
is the real business data, so after proving convergence the verification restored baseline
exactly: re-ingested tcgcsv Phantasmal Flames to put the 143 names/set-names back, deleted
the 13 created items and all 156 cardtrader + 153 cardmarket + 1 tcgplayer refs it added
(identified by `created_at`, cross-checked against a pre-run snapshot: `catalog_items` 8998,
`tcgplayer` refs 8997, `cardmarket` 1), removed the `catalog:cardtrader` credential and the
throwaway admin session, and restored `hub-app-032` from the `main`-built `inventory-hub:local`
image. **Verified back to 8998 items, 0 cardtrader refs, only the Shopify credential.** The
throwaway test DB on 5433 could not host this check — it lacks the 8998 catalog items the
convergence demo needs — which is why it ran against the live DB and had to be undone.

Full suite green: **catalog-cardtrader 34 tests** (blueprints 11, source 23), the 8 new
`CatalogCredentialsService` tests, and the whole `apps/api` suite run **against the real test
DB — 35 files, 658 tests, 0 skipped** — so the fill-empty-only refresh and the DB-backed
ingest paths are actually exercised, not just typechecked. lint/format/typecheck/build clean
across the workspace.

### The Dependabot backlog, cleared — three majors, each real work (2026-08-06/07)

bullmq 5→6 (#78), eslint-config-prettier 9→10 (#79), vitest 3→4 (#80). None was a
rubber-stamp; two needed code changes and the third exposed a latent packaging bug. Each was
**redone on current `main` rather than merging Dependabot's own branch** — those branches'
lockfiles predated the CardTrader merge, so a fresh branch (the bump plus the fix, with a
regenerated lockfile) superseded each Dependabot PR, which was then closed. (Watch the
`@dependabot ignore` commands when closing: one slipped into a close comment and had to be
reversed with `@dependabot unignore this dependency` — it would otherwise have suppressed
future bullmq updates.)

**bullmq 6 removed the legacy repeatable-jobs API** — `getRepeatableJobs`,
`removeRepeatableByKey`, and the `repeat` option on `add` — in favour of **job schedulers**.
`ReconcileQueue.scheduleSweep` (the nightly reconciliation) was the sole user; it now calls
`upsertJobScheduler(id, { pattern }, { name, data })`. The upsert is keyed by a stable
scheduler id, so a changed `RECONCILE_CRON` updates the one schedule in place — exactly what
the old remove-then-add loop guaranteed, now free, so that loop is gone. Two things checked
rather than assumed: ioredis is already a direct dependency (v6 makes it optional), and
nothing uses the other removed surfaces (`Queue#client`, `waitUntilReady`'s return,
`debounce`, `Job#discard`, `Worker#resume`) — the outbound burst-collapse fix is
jobId+`removeOnComplete`, not `debounce`, so it is untouched. **One-time Redis transition**:
a repeatable registered by a v5 build lives under keys v6 cannot see or remove, so the first
boot after upgrade may fire the old sweep once before it self-clears (one "failed" warning);
the sweep is idempotent, so it is harmless — the `bull:reconcile:repeat:*` keys can be
`DEL`eted first to avoid even that. Verified with a live smoke test: re-upserting with a
different pattern leaves one scheduler, not two.

**vitest 4 dropped `dist/` from its default test-discovery exclude.** Every package excludes
specs from its build except `@hub/db`, which was emitting `dist/enums.spec.js`; vitest 4 then
discovered that compiled CommonJS spec and failed trying to `require()` the now ESM-only
vitest — surfacing under the "Tests (postgres)" CI job, which runs the whole recursive suite
(so the failure was really in `packages/db`, not `apps/api`, despite the job name). Fixed at
the root by excluding specs from db's build, matching every other package. **The reusable
rule: keep specs out of every package's built `dist/` — vitest 4 will otherwise find and
choke on them.** The vitest configs themselves needed nothing (`globals`, `environment`,
`include`, `setupFiles`, `fileParallelism`, `resolve.alias` all survive v4).

**eslint-config-prettier 10** was a clean dev-config bump: v10 removed the deprecated CLI
helper and the `eslint-config-prettier/prettier` special-case, neither used here — the flat
config imports the default export and spreads it, unchanged in v10.

**GitHub Actions had a day-long partial outage in this window**, which stranded #80's CI as
`queued` for over a day ("The job was not acquired by Runner of type hosted"). This looks
exactly like a hang; check `githubstatus.com` before assuming a stuck or failed CI run is
your code. The fix once runners returned was to rebase and force-push for a genuinely fresh
run — a re-run of a stuck-`queued` run is refused as "already running".

### Reconcile report: name each listing, and correct the ledger from a drift (#81, 2026-08-06)

The reconcile report identified a differing listing only by its platform id — a `gid://…`
that names nothing. Two operator-requested changes.

**Every finding now carries the product's name, set and condition**, threaded through
`diffLiveState` from the catalog item behind the allocation (`ChannelListing` gained an
`inventoryItemId` too), and each drift row leads with the name while the gid stays as muted
secondary text. It rides on drifts and pending pushes via a **conditional spread**, so a
finding with nothing to name stays byte-identical to before — which is what keeps the
existing exact-equality tests honest and is worth preserving in any change here.

**A quantity-drift row can correct the ledger** when the channel is the side that is right:
a number input defaulted to the channel's figure (so the common case is one click) plus a
"Set ledger" button, going through a new `PUT /inventory/:id/quantity` →
`InventoryService.setQuantityOnHand`, recording a **`reconcile`** stock movement. This is the
deliberate human-driven counterpart to the standing rule that reconciliation never pulls from
the channel automatically ("picking a policy silently would be reconciliation by accident",
under the inventory-import note) — the operator decides per line. Offered only for `quantity`
findings, the only ones with a channel quantity to adopt. A **pooled** item then pushes the
corrected number to its channels through the normal path (a no-op on the channel that was
already right). Verified end-to-end against the running container on a **no-allocation** item
(movements recorded, then reverted — zero store impact); deliberately **not** clicked on a
live store-linked drift, because that adjusts real stock and pushes to the live store, which
is the operator's call, not a verification step.

### Unmerged work

None. Everything through **#142** is on `main` and released as **v0.10.2**, which adds no
migration on top of 0.10.1 — a clean drop-in, as 0.10.1 was on 0.10.0. **0.10.0 was the one carrying migrations**
(`sellout_scope`, then `reactivate_on_restock` + `sellout_drafted_at`), the first since
0.8.0, applied automatically by the entrypoint.

**Production is on 0.10.2** (updated 2026-08-20). The operator ran the listing-rule
back-fill over their 462 listings on 0.10.0, which is what prompted #137's Apply-button
move — the first feature in a while whose design was corrected by someone actually using
it at scale. **Email alerting is live in production and tested (2026-08-17)**; the token
had to be entered by hand there, because secrets do not travel with the image.

**`draftAtSellout` is enabled on the live Shopify channel and works** (confirmed by the
operator, 2026-08-20). That closes the last "never run against the real storefront"
caveat, which this file carried from v0.7.0 through v0.10.2 — the policy shipped in
v0.7.0, gained a nightly sweep and a scope setting in v0.10.0, and had until now only ever
been proven against a copy.

**`reactivateOnRestock` is still unexercised**, and is now merely waiting rather than
blocked: it is off by default and separate on purpose, and it needs a listing the hub
itself drafted (the `selloutDraftedAt` stamp) that then comes back into stock. With
drafting live, that situation will arise on its own.

**Backlog, in the operator's words.** The in-store kiosk is **shelved**: the storefront
already does this, so they will improve its own page design and filtering instead — which
also removes the unauthenticated-route question entirely. What is left:

- **Improve matching on the `/match` page.** Still the largest item.
- **Inventory screen**: select several conditions at once; sort by price within the
  channels column; and select several items and add them all to a channel in one go,
  priced at the current market figure. That last one needs a market price at the moment
  of allocation, which is `MarketPrice` — latest-only, so an item the sweep has never
  priced has nothing to use, and the flow has to say so rather than allocate at null.
- **Repricing: split `autoApplyMaxPct` into separate up and down thresholds.** The risks
  are not symmetric — a price rising on its own costs a sale, a price falling on its own
  costs margin — so one number cannot express the operator's real tolerance. Note the
  parser is the one CodeQL caught a prototype-pollution bug in, so any new key goes
  through the closed vocabulary, not the request object.
- **Catalogue duplicates**, specced in [docs/CATALOG_DUPLICATES.md](docs/CATALOG_DUPLICATES.md):
  detect and report first, merge only on the operator's say-so, and consider storing the
  collector number to prevent most of them.
- **Re-check tcgcsv for Palworld.** Now less urgent — `catalog-palworld` reads Bushiroad's
  own database — but tcgcsv arriving is still what brings prices and convergence.

**No catalogue carries the Palworld TCG yet** (checked 2026-08-17). It launched 2026-07-30,
and TCGPlayer has no category for it — so tcgcsv, which mirrors them, has nothing to
republish, and CardTrader's 14 games do not include it either. **The answer is to wait, not
to build**: the day TCGPlayer opens the category it arrives for free, exactly as Pokémon
Japan did. Nothing is blocked meanwhile — the ledger holds a game no catalogue knows, and
such an item still lists on Shopify under its `hub:` code. See "Catalogue gaps to re-check"
in [docs/CONNECTOR_ROADMAP.md](docs/CONNECTOR_ROADMAP.md) for the re-check and why a
bespoke source would be wasted work.

**The first production run of the whole unmapped-sale remedy worked** (2026-08-13 to -15):
the operator linked the sold, unlinked listing through 0.9.1's manual link and then set On
hand, because **linking credits no stock by design**. Both halves were needed; the second
is the one easy to forget.

### v0.10.2 (2026-08-19)

Tagged after the "Prepare v0.10.2" merge (#143), carrying #140–#142. Tags `0.10.2`, `0.10`
and `latest` all at digest `sha256:90d50e14…`, replacing 0.10.1's `sha256:0de03547…`.
**No migration** — a clean drop-in on 0.10.1.

Verified the established way. Anonymously: three tags at the one digest, with real
`linux/amd64` and `linux/arm64` children. Inside the pulled artifact: version 0.10.2,
`packages/catalog-palworld/dist` present, the source registered in the built registry, the
reprice fix in the built `reprice.service.js`, zero compiled specs (the 0.10.1 fix holding),
and `--prod` held. Booted clean and logged
**`Registered catalog source(s): scryfall, tcgcsv, cardtrader, palworld`** — which is the
registration proven in the artifact rather than asserted — reporting `info.version: 0.10.2`
with 71 paths.

- **`packages/catalog-palworld`** — Bushiroad's own card database, because no marketplace
  catalogue carries the game: it launched 2026-07-30, TCGPlayer has opened no category, so
  tcgcsv has nothing to mirror and CardTrader's games do not include it (all three checked
  live, 2026-08-17). An **undocumented WordPress plugin route** found in the card list's
  own JavaScript — first-party and unauthenticated, same risk class as tcgcsv's CDN.
  - **No prices** (a publisher database has no market) and **no cross-references**, so a
    later tcgcsv ingest will create a _second_ item per card rather than converging —
    unlike CardTrader, which converges precisely because it publishes `tcg_player_id`.
    Hence: **search at intake, do not bulk-ingest**, so only stocked cards need
    reconciling later. That was the operator's own call.
  - **Simpler than tcgcsv and CardTrader, honestly so.** The whole English catalogue is
    256 cards, so it reads all of it once: an unscoped search is a fair question, and
    `fetchById` works from cold — the failure that once broke a live SKU write mid-run
    cannot occur here. A page cap throws rather than silently reading a fraction.
  - Live from the built package: 4 sets, 256 cards, search by name and collector number, a
    resolving image, a `fetchById` round trip, 162 in EBP01, no price anywhere.
- **The repricing sweep stopped reporting a source that missed** (#141). Five red lines
  naming sets tcgcsv could not find were all cards **Scryfall priced a moment later** —
  the passes are a fallback chain. Misses are held and resolved at the end against what
  was actually priced.
  - The cause is real and untouched: a Magic card taken in through Scryfall keeps
    Scryfall's set spelling, and tcgcsv spells the same set `FINAL FANTASY`,
    `Universes Beyond: Doctor Who`, or splits `Secret Lair Drop` across many groups. The
    set lookup was documented as safe because "stored names came from that same listing";
    true while tcgcsv was the only thing creating Magic items — 8,347 of them against 2
    involving Scryfall.
- **`docs/CATALOG_DUPLICATES.md`** specs the "some show up twice" report: two sources
  converge only where they share an id namespace, so detect-and-report first, merge only
  on the operator's say-so, and consider storing the collector number as prevention.

### v0.10.1 (2026-08-17)

Tagged after the "Prepare v0.10.1" merge (#138), carrying #136–#138. Tags `0.10.1`, `0.10`
and `latest` all at digest `sha256:0de03547…`, replacing 0.10.0's `sha256:d8125603…`.
**No migration** — a clean drop-in on 0.10.0.

Three things, all of which came from the software being used rather than designed:

- **Apply moved above the table** on both batch panels (#137). Running the back-fill over
  462 production listings meant scrolling a fifty-row table twice per batch, nine times
  over. The confirmation expands in place in the same row.
- **The push-failure alert links to its item, and the drift alert to reconciliation**
  (#137). The first needed `raiseFlag` to refresh `inventoryItemId` alongside title and
  detail — a flag describes its _latest_ occurrence, so an item kept from the first raise
  would name one card beside text about another. The second is keyed on the flag's
  **source, not its kind**: `reconcile_drift` covers both the sweep's drift, which
  reconciliation fixes, and the inbound worker's unmapped sale, which it does not.
- **`apps/api` stopped shipping its compiled specs** — 39 → **0**, confirmed in the pulled
  artifact. `packages/db` got that exclude during the vitest 4 work and this one was
  missed.

Plus the minor-and-patch dependency group (#136): eslint, `@nestjs/*`, `@node-rs/argon2`,
bullmq 6.1.0, fastify 5.12.0, `unplugin-swc`. **The `fastify@5` override reads `^5.11.3`,
which already covers 5.12.0**, so there was no override/lockfile disagreement — and the
build job's `--frozen-lockfile` install passing is what proved it rather than an
assumption. 0 open security advisories.

Verified the established way: anonymously, three tags at the one digest with real
amd64+arm64 children; inside the artifact, version 0.10.1, zero spec files,
`fastify@5.12.0` and `bullmq@6.1.0` in the runtime tree, `--prod` held; booted clean and
its own OpenAPI document reports `info.version: 0.10.1` with 71 paths.

### v0.10.0 (2026-08-16)

Tagged after the "Prepare v0.10.0" merge (#134), carrying #125–#133. Tags `0.10.0`, `0.10`
and `latest` all at digest `sha256:d8125603…`, replacing 0.9.2's `sha256:7a1b13b4…`.
**Contains the first schema migrations since 0.8.0** — `sellout_scope`, then
`reactivate_on_restock` + `sellout_drafted_at` — both additive with safe defaults, so every
existing channel keeps the behaviour it had.

Verified the established way. Anonymously: all three tags resolve to the one digest, and
the index carries real `linux/amd64` and `linux/arm64` children plus the two attestation
manifests. Inside the pulled artifact: version `0.10.0`, both migration directories
present, `sellout.service.js` carrying `reactivateIfRestocked`, `attributes/backfill` in
the built listings controller, `listSets` in the built inventory service, and `--prod`
held (zero `vite`/`vitest`/`esbuild`). Booted against the throwaway services on 5544/6380:
starts clean and its own OpenAPI document reports `info.version: 0.10.0` with 71 paths,
including all four new routes.

**One thing the artifact check turned up, pre-existing and not a regression: `apps/api`
shipped its compiled spec files in the image** — 39 of them in 0.10.0, 37 in 0.9.2. It
contradicted the rule the vitest-4 work wrote down ("keep specs out of every package's
built `dist/`"), and `packages/db` was given `"exclude": ["src/**/*.spec.ts"]` then while
`apps/api` was not. It was **untidy rather than harmful**: this package's vitest `include`
is `['test/**/*.spec.ts', 'src/**/*.spec.ts']`, scoped to source, so the discovery
breakage that hit `@hub/db` could not occur here. **Fixed in v0.10.1** with the same
one-line exclude; only `src` needs naming, since `include` is src-only and `test/` was
never compiled.

### After v0.9.2 — #125–#133, shipped in **v0.10.0** (2026-08-15/16)

Back-filling what the rules would have applied, and catching up on what the event path
missed. Both exist for the same reason: **a rule or a policy written after a listing was
created reaches nothing that already exists**, and on a tag-driven storefront the result is
invisible rather than loud.

#### Listing-rule back-fill: tags, then custom fields (#125–#129)

`listing.attributes` → `updateListingAttributes`, `ListingAttributesService`,
`POST /channels/:id/listings/attributes/{pending,backfill}`, and a channel-card panel.
Started as tags (#125) with two rounds of real-data fixes — select-all that decrements
through the whole list (#126), and returning to the section head after a run (#127), the
same treatment then given to listing images (#128) — and grew to custom fields (#129).

- **The safety rule differs by kind, and the asymmetry is the design.** Tags are a set, so
  the connector writes the union and one applied by hand survives. A metafield holds
  **one value**, so writing it is always a replacement: a field the listing already carries
  is left exactly as it is, whatever it says. A rule firing on the game cannot know the
  operator hand-picked something else for one card — the same argument that made the
  catalog ingest's refresh fill-empty-only.
- **One Shopify read carries tags, category and metafields together**, then at most one
  `productUpdate`: two round trips per listing at 2/s, not four. There is **no
  `HasMetafieldsIdentifier` argument in `2026-07`** — that was the first attempt.
  `read_products` + `write_products`, no scope change.
- **A stored empty value counts as absent.** Shopify deletes a metafield set to `""`, so a
  row surviving with one is a field with no value; reading it as present would leave the
  listing permanently unfillable.
- **The category is applied only where the product has none**, and only beside a field that
  needs one. A conditional definition cannot be satisfied by a product with no
  classification, but reclassifying one the operator already categorised is not this call's
  business. Both directions pinned.
- **Product-owned fields only**; a variant-owned one is refused **by name** rather than
  skipped, because a silent skip reports a field as set that was never written.
- **`suggestChoice` is `suggestTag` for metaobject entries** — matched on the **label**,
  since the value is a GID meaning nothing outside one shop, and refusing on ambiguity.
  It **self-filters across fields** (`custom.game`'s entries are game names, `custom.set`'s
  are set names), which is what makes offering every field against every value safe rather
  than a shotgun. Live: **twelve `custom.set` proposals, every one a punctuation change**
  (`ME01: Mega Evolution` → `ME01 Mega Evolution`).
- **Only the caller can name a value.** The result carries the whole metafield rather than
  its key, and the panel resolves both halves against `listMetafields` as the rules editor
  does — `Game = Pokémon TCG`, not `custom.game`. The fallback to `namespace.key` is
  load-bearing: that read can fail (a missing scope answers null with no error) and a chip
  that then said nothing would read as a listing with no work to do.
- Live against the production copy: **232 listings offered, 160 resolving at least one
  custom field.** The **write path has never touched the real storefront** — the operator
  runs it, the same call as the reconcile ledger correction.

#### The sold-out sweep, and scope as a setting (#130)

`draftAtSellout` has been event-driven since v0.7.0, so it reaches nothing that sold out
**before** the channel opted in and nothing whose stock reached zero without a push. The
operator's store had nine such singles, and the toggle was off, which is why none had ever
been drafted.

- **`SelloutService.draftIfSoldOut` is the whole policy and both paths go through it**; the
  worker's copy is gone. The existing worker tests pass unchanged through the shared
  method — that is the proof the refactor changed no behaviour, and what let the scope
  setting gate both paths for free.
- **`SELLOUT_CRON`** (04:00) installs a BullMQ job scheduler like reconcile and reprice.
  Last of the three deliberately: reconciliation may correct a quantity the hub had wrong,
  and a card the ledger only now believes is at zero should be drafted that night.
- **Both zeros are required, and the redundancy is the safety**: the channel advertising
  nothing _and_ the item holding nothing. With stock in the ledger a push could be in
  flight, and drafting ahead of one leaves a card back in stock and invisible, which
  nothing here ever undoes. The event path acts on the exact derived figure because it has
  it in hand; the sweep is the catch-up and is allowed to be blunter.
  `desiredListedQuantity` is **derived, not a column**, so it cannot be queried on.
- **`selloutScope` is per channel** (`singles` default, `all`), replacing a hardcoded rule.
  Sealed product is restocked far more often than a given card, so hiding a booster box
  that will be back next week is churn when re-publishing is manual. **An unrecognised
  value reads as `singles`** — the conservative direction, not merely a default: widening
  what gets unpublished has to be chosen. Measured on the live copy: the default drafts
  **9 singles**, `all` would additionally unpublish **117 sealed products**.
- Verified without touching the store: the endpoint refused with 400 on the real channel
  (toggle off); the candidate predicate was run against the restored production database;
  the panel was rendered with the toggle flipped **in the copy only**; and the scheduler
  was exercised against real Redis — a changed pattern **moves** the one entry rather than
  adding a second.

**`hub_prodlike` needed the new migration applied by hand** (`prisma migrate deploy`
against it), because that launcher runs none — the schema-drift trap the dev-instance note
warns about, now actually hit. It hit again on #133, so treat it as routine.

#### Publishing again on restock, and the permission slip it needs (#133)

The counterpart to the sellout policy, opt-in and off by default. "One direction only" was
the rule from v0.7.0 and is still the default — but it was the hub deciding for the
operator, and a shop whose stock turns over weekly wants the other answer.

**No platform can say who drafted a product.** Shopify has no such field, checked before
designing around one, so `ChannelAllocation.selloutDraftedAt` is the hub's own record:
stamped only when a draft actually happened, cleared the moment it is spent. Without it the
restock path could not tell a listing the hub hid from one the operator hid on purpose.

- **Cleared before the channel is asked, not after.** A failed activation leaving the stamp
  would retry on every later push, and a listing drafted by hand meanwhile would keep being
  pushed at. Permission for one attempt, not a standing instruction. Mutation-checked, as
  is the stamp gate.
- **Its own toggle**, because the risks are not symmetric: a sold-out page left up costs
  nothing, publishing something held back deliberately is not recoverable afterwards.
- **Null for every existing row** — nothing drafted before the column existed can be
  attributed to the hub, so none of it is ever re-published.
- The nightly sweep stays drafting-only: adding stock always goes through
  `InventoryService` and so always queues a push, which is the event this reacts to.

#### Two smaller ones (#131, #132)

- **The repricing review links to the market it quotes** (#131). `ProposalRow` carries the
  catalogue's external **ids, never URLs** — which sources have a linkable public page is a
  fact about the web that has already changed once (Cardmarket went bot-walled), and
  `externalLinks` in the web app owns that judgement. Reusing it also collapses tcgcsv and
  tcgplayer to one link. Verified live: `tcgplayer.com/product/662182` returns 200.
- **A set filter on the inventory browser** (#132), enabled once a game is chosen.
  **Scoped to a game**, and an unscoped call answers an empty list rather than everything —
  the caller has not asked a question yet. **The set clears when the game changes**, and the
  route drops a `set` param arriving without a `game`: a set from another game matches
  nothing, and a filter that silently empties the table reads as a broken page. Counted in
  **one** query over the ledger (hundreds of rows) rather than one per option, unlike
  `listGames`. Live: 34 Pokémon sets with real counts.

**The first production run of the whole unmapped-sale remedy, and it worked** (2026-08-13
to -15): sales had arrived for `gid://shopify/ProductVariant/45781411627061` with no
allocation mapping to it. The operator linked it through 0.9.1's manual link (Activity →
the unmapped-sale alert → "Link to inventory →") and then set On hand, because **linking
credits no stock by design** and the ledger was still over-stated by the units already
sold. Both halves were needed; the second is the one easy to forget, and worth stating in
any future write-up of this path.

### v0.9.2 (2026-08-15) — a channel card at a glance

Tagged after the "Prepare v0.9.2" merge (#123), carrying #121 and #122. Tags `0.9.2`,
`0.9` and `latest` at digest `sha256:7a1b13b4…`, replacing 0.9.1's `sha256:8a646c06…`;
verified anonymously and inside the artifact (version, `dist/version.js`, the
`health/version` route in the built controller, the folded-section strings in the built
bundle, `--prod` held). **No migration.**

- **Channel sub-sections fold** (`ChannelSection`), collapsed by default — a card with a
  large rule set was burying repricing and reconciliation behind a scroll past rules
  nobody was reading. Manual sync stays open on file channels: its round trip is the
  card's purpose, not a setting. **A folded section reports its own state** (rule count,
  repricing On/Off plus pending proposals, auto-correct) — that is what makes folding
  safe rather than merely tidy, and the same argument as the settings panels' badges.
- **The hash scroll now opens the target itself**, not only its ancestors. The repricing
  section is both a disclosure and the id the `reprice_review` alert links to, so without
  this the alert would have landed on a folded section. The general rule: a deep link
  whose success depends on which sections the reader happened to fold is the worst kind
  of intermittent.
- **The version is reported by the server, not the bundle** (`apiVersion()` moved from
  `main.ts` to `version.ts`, read once). `main.ts` had already written the argument in a
  comment — a second copy of a version string is forgotten at a release — so the fix was
  to share the reader rather than add a constant. `version.ts` compiles beside `main.js`,
  so `join(__dirname, '..', 'package.json')` holds for any importer however deep.
  **The endpoint is authenticated**, unlike the liveness probes in the same controller: a
  version narrows which advisories apply, and nobody signed out needs it.

### v0.9.1 (2026-08-13) — link a sold, unlinked listing from its alert

Tagged after the "Prepare v0.9.1" merge (#118), carrying #117 alone. Tags `0.9.1`, `0.9`
and `latest` at digest `sha256:8a646c06…`, replacing 0.9.0's `sha256:792a5c71…`; verified
anonymously and inside the artifact (version, the manual-link panel in the built bundle,
`--prod` held). **No migration.**

Born from a real production event: sales arrived for an unlinked listing and the match
screen had no manual override — proposals only offer what resembles a catalogue name, one
page of enumeration at a time. The fix is **UI-only**: `/match` gains a "Link one listing
manually" panel (platform id + local-catalogue search + condition/printing/language), and
the unmapped-sale alert carries "Link to inventory →" which lands there with the id
prefilled via a new `listing` search param. The same `confirm` endpoint serves it — the
server never required the pair to have been proposed — so every guard holds and linking
credits no stock. After linking, the missed sales still need the ledger corrected: set On
hand, or reconcile and "Set ledger".

### v0.9.0 (2026-08-12) — the notification suite and the UI pass

Tagged after the "Prepare v0.9.0" merge (#115). Multi-arch image, tags `0.9.0`, `0.9` and
`latest`, all at digest `sha256:792a5c71…`, replacing v0.8.0's `sha256:42ee80b1…`.
Everything from #106 to #114. **No schema migration** — a clean drop-in from 0.8.0.

Verified the established way: anonymously, all three tags at the one digest with real
amd64+arm64 children; inside the pulled artifact, version 0.9.0, `email.service.js` /
`syslog.service.js` in the built sync dir, `nodemailer@9.0.5` in the prod tree with zero
`vite`/`vitest`/`esbuild`, the syslog/email routes in the built settings controller, and
the `data-theme` palettes in the built CSS.

Decisions worth not re-deriving:

- **Email and syslog disagree about repeats, on purpose.** A flag refreshed at the same
  severity never re-emails (an inbox that hears every occurrence filters the sender —
  only a new alert or an escalation sends, the subject saying what it was before), while
  syslog ships every refresh because dedup is a log collector's job. Both are
  fire-and-forget from `AlertsService`/`SyncEventService`: a dead sink can never fail the
  write it describes.
- **Notification settings live in the `Setting` table** (`notify.email.*`,
  `notify.syslog.*` — the AuthSettings precedent, no migration), the SMTP password in the
  encrypted credential store under `notify:email`. The operator's provider is **Cloudflare
  Email Sending over SMTP** (`smtp.mx.cloudflare.net:465`, implicit TLS, username
  literally `api_token`, an Email-Sending API token as password, from-domain onboarded) —
  chosen over their REST API deliberately: SMTP is the provider-agnostic seam for
  self-hosted software and the REST surface is beta. **Proven with a real delivered
  email** by the operator; the fake-token path proved the transport (Cloudflare's real
  `535` reported honestly in the panel).
- **Container logs are deliberately not shipped by the in-app syslog** — Docker's syslog
  logging driver covers stdout with zero hub code (commented lines in the production
  stack.yml), and shipping both would duplicate every line. Azure Log Analytics stays
  deferred: the legacy HTTP Data Collector API loses support 2026-09-14, and Azure
  Monitor Agent can collect from a syslog collector anyway — possibly zero hub code ever.
- **`ListingUrlResult` gained `title`** (variant `displayName`, verbatim including
  " - Default Title"; the web trims at display time) so the unmapped-listing alert names
  what sold. Resolved live per render, so old alerts get named too.
- **Themes are chrome only.** Four palettes via `data-theme` variable overrides; the
  error red and pooled green are deliberately unthemed. Per-browser localStorage via the
  devMode store pattern — which is also what makes it per-user for the operator's
  employee with editor access.
- **A pnpm override must move with the dependency it pins** (found by #110's CI failure):
  `pnpm update` bumped fastify's specifier in the lockfile while the `fastify@5` override
  still said `^5.11.0`, and every `--frozen-lockfile` install then refused the lockfile —
  pnpm compares against the override-rewritten specifier. The ioredis 6 (RESP3 under the
  queue layer) and react-table 9 (`useReactTable` deleted) majors are on the ignore list,
  assessed and deliberately deferred; security updates still override.
- **`pnpm.overrides` is on borrowed time, and `pnpm check:overrides` is the alarm**
  (2026-08-20). pnpm 9.15.4 now warns that the `pnpm` field in `package.json` "is no
  longer read". **It still reads it** — an install under that warning rewrote the lockfile
  for #142 with all four overrides intact, and the resolved tree satisfies every pin. So
  there is nothing broken today.
  - **Moving them to `pnpm-workspace.yaml` does not work under pnpm 9**, tested rather
    than assumed: relocating `fastify@5` alone and re-resolving dropped it from the
    lockfile's `overrides` block entirely. So they stay in `package.json` until the pnpm
    10 upgrade moves them deliberately — and that upgrade must verify the pins afterwards,
    not just that the install succeeded.
  - The failure mode is the dangerous kind: an install regenerates the lockfile without
    them, every advisory quietly returns, and **CI stays green** because nothing else
    asserts which versions resolved. `scripts/check-overrides.mjs` runs in the build job
    before anything is compiled and fails on a missing _or_ drifted override. It has no
    dependencies, so it cannot be broken by the resolution problem it detects.
- **The fast-iteration dev instance built this release**: Vite HMR on 5173 + watch-mode
  API on 3005 against a throwaway `hub_dev` DB, workers off, fake channel credentials —
  see the untracked memory notes. UI changes were verified live in seconds; the syslog
  path was proven with a real UDP datagram caught in-session.
  over the tunnel after the operator updated the stack on 2026-08-10 (version, all new
  routes, the `draft_at_sellout` migration applied by the entrypoint, webhook ingress still
  verifying). The seeded rule set on the live Shopify channel has been **active since the
  0.6.x deploy** and is proven: the first rules-engine product came out with vendor, game
  metafield, tags, category and both sales channels applied.

**The sales loop is running in production.** At the v0.7.0 verification the ledger held
**7 `sale` stock movements** where history had exactly one (the old test order) — real
Shopify orders decrementing stock through the live `ORDERS_CREATE` webhook, unprompted.
The catalog had grown to 23,414 items and 218 allocations, all through the production UI.
The operator also ran the image re-push from the production channel card and confirmed
the storefront photos updated.

**Dependabot: 0 open alerts** (#101, 2026-08-10). Two highs — `nanoid` < 3.3.17 and
`js-yaml` 4.x < 4.3.1 — were both **build-tree transitives** (postcss←vite;
cosmiconfig←fork-ts-checker/eslint) despite the "runtime" scope label, verified by
listing the published 0.7.0 image's module store: no nanoid at all, and only the
separately-pinned `js-yaml@5.2.2`. Both parents declare ranges, so a plain `pnpm update`
cleared them — no overrides, per the `fast-uri` lesson.

v0.4.0 went out as a minor rather than the v0.3.1 first planned: by the time the queue fix
was released it had a schema migration and five features beside it.

`listing.metafields` merged as **#37**, carrying the three decisions the operator made
while it was open — sealed gets no variant option, `NA` with it, and the set is appended
to a single's title only. The two draft products it was demonstrated on were deleted
afterwards and their ledger rows zeroed.

#26 was reviewed and merged on 2026-07-30 with the cross-source guard above added
during review. `shopify-client-credentials` was merged on 2026-07-29 once webhook
delivery was proven against the live store (below), which was the one thing holding it
back.

`main` may be a few commits ahead of `origin/main` — check before assuming CI has seen the
latest.

### v0.8.0 (2026-08-11) — the repricing engine

Tagged at the "Prepare v0.8.0" merge (#104). Multi-arch image, tags `0.8.0`, `0.8` and
`latest`, all at digest `sha256:42ee80b1…`, replacing v0.7.0's `sha256:e3bffcad…`. One
feature, #103: **prices follow the market** — a daily sweep (`REPRICE_CRON`, default
03:30, a BullMQ job scheduler that installs itself on first boot) pulls market figures
for every allocated item and moves asking prices under per-channel policy: percent of
market per condition, `.99` rounding, floor, churn guard, and `autoApplyMaxPct` — within
it auto-applied and pushed, above it a proposal with Apply/Dismiss on the channel card.
**Contains a schema migration** (`market_prices`, `reprice_proposals`,
`channel_instances.repricing_policy`).

Decisions worth not re-deriving:

- **Prices are per printing end to end.** `CatalogCandidate.pricesByPrinting` exists
  because tcgcsv's rows are per-finish and `toCandidates` collapsed them to the normal's
  scalar — a foil repriced off the plain printing's market is the wrong price with no
  error. A printing with no published figure is **skipped, never** given another
  printing's number.
- **The hub never invents a multiplier.** A condition without a declared percentage is
  never repriced (the `deriveSkuDimensions` argument again: condition is most of what a
  single is worth). No threshold set means everything reviews; an unpriced allocation
  always reviews (no base to measure the change against).
- **tcgcsv is swept by whole set files** found by exact `setName` against `listSets` —
  `fetchById` is cold-start-blind by design, and stored names came from that same listing
  so equality holds. Scryfall goes per card. CardTrader publishes no prices.
- **Applying a price is a column write plus an outbound `price` push** — nothing else
  enqueues `operation: 'price'` today, and `upsertAllocation` was deliberately not used:
  it would restate mode/partition figures the sweep has no business touching (rule 5
  guards quantities; a price is channel data).
- **`market_prices` is latest-only** with `previousPrice` for was/now — a history table
  needs its own retention story (the query-console precedent). Proposals are one per
  allocation, replaced by sweeps, **deleted on decision**; a dismissal is deliberately
  not remembered — the market still says what it says.
- **CodeQL caught a real remote-property-injection** in the policy parser, its second in
  this repo (#17's was the first): `conditionPercents` keys came off the PATCH body and
  became property names, so `__proto__` was writable. Fixed by iterating the closed
  `SKU_CONDITIONS` vocabulary rather than the request object. Its follow-up nit was also
  right: `__proto__: 50` in an **object literal** is a silently-ignored prototype-set, so
  the first regression test never contained the key it existed to pin — raw JSON text
  does. **Watch for both shapes in any new request-keyed map.**
- **The local full-suite runs were failing on pure infrastructure** — test-DB connection
  drops with different unrelated files failing each run (one a no-I/O crypto test), while
  CI's identical suite passed twice. The tell distinguishing infra flake from real
  breakage: the failing _set_ is unstable across runs and the errors are connection
  timeouts, not assertions.

Verified the established way: anonymously, all three tags at the one digest with real
amd64+arm64 children; inside the artifact, version 0.8.0, the `add_repricing` migration
directory, `apps/api/dist/pricing/` with the `SKU_CONDITIONS` allowlist in the built
parser, `pricesByPrinting` in both built sources, `--prod` held.

### v0.7.0 (2026-08-10)

Tagged at the "Prepare v0.7.0" merge (#99). Multi-arch image, tags `0.7.0`, `0.7` and
`latest`, all at digest `sha256:e3bffcad…`, replacing v0.6.1's `sha256:d951eb6d…`. Four
features — #92 image re-push (singles only; sealed imagery is the operator's), #96
external + storefront links (`listing.url`; Cardmarket deliberately unlinked, bot-walled),
#97 the intake language picker (what makes a JP-language copy expressible), and #98 draft
sold-out singles (`listing.status` with the platform-side `totalInventory` guard;
**one-directional by design** — restock never re-publishes). **Contains the first schema
migration since v0.4.0** (`draft_at_sellout` on channels), applied automatically by the
entrypoint.

Verified the established way: anonymously, all three tags resolve to the one digest with
real amd64+arm64 children; inside the pulled artifact, version 0.7.0, the migration
directory present, `maybeDraftAtSellout` in the built worker, the images service and
`listingUrl` route in the built API, all three new methods in the built connector, and
`--prod` held.

Also settled around this release, recorded in the untracked memory notes: **Pokémon Japan
is tcgcsv category 85 (454 sets) — ingestable with zero code**, so no TCGdex source was
built; **One Piece JP needs no source either** (numbered sets share JP/EN identity, and the
JP/Asian-exclusive promos are on the already-registered CardTrader source); PriceCharting
was assessed and **tabled** ($49/mo API tier, and the operator is exiting graded cards).

Facts under the image re-push worth not re-deriving: **a hub-created single carries exactly
one media** — the variant's `mediaSrc` at creation references the product media rather than
duplicating it (measured on a live product), which is what makes replace-wholesale safe;
**`productDeleteMedia` is deprecated in 2026-07** but its replacement (`fileUpdate`) needs
the `write_files` scope the app does not carry, so the deprecated mutation is kept with a
note (the `Publication.name` precedent) while adding goes through the non-deprecated
`productUpdate(media:)`; and **2,718 production rows had to be re-backfilled** to
full-resolution URLs — items ingested between the local image backfill and the production
deployment kept `_200w` thumbnails, which is how a post-upgrade product (Vinsmoke Reiju)
still went live with a 200px photo. All three image-URL upgrades live in source code now,
so the gap cannot reopen.

### v0.6.1 (2026-08-09)

Tagged at the "Prepare v0.6.1" merge (#90). Multi-arch image, tags `0.6.1`, `0.6` and
`latest`, all at digest `sha256:d951eb6d…`, replacing v0.6.0's `sha256:6446ac38…`. A patch
carrying the two defects the **first production deployment** surfaced the same day, both
found live and fixed with regression tests:

- **#89 — the CSP blanked plain-HTTP LAN deployments.** Helmet merges its default directives
  into a configured CSP, and the default set includes `upgrade-insecure-requests`; browsers
  exempt localhost, so every previous access (all `http://localhost`) hid it, while
  `http://192.168.x.x` had its JS/CSS force-upgraded to https and rendered a blank page.
  Diagnosed with headless Chrome (playwright-core + installed Chrome) against the live
  server after the Browser pane refused LAN reads. The directive is nulled — the CSP is
  `'self'`-only, so subresources inherit the page's scheme and https loses nothing.
- **#88 — `createListing` sent `category` to `productCreate` verbatim**, so a bare taxonomy
  handle (`ae-2-2-3-2`, exactly what a channel's `listingDefaults` may hold) was rejected as
  an invalid global id and the creation failed. Now normalised through the existing
  idempotent `toTaxonomyGid`, as `listMetafields` already did.

Verified inside the pulled artifact: version 0.6.1, `upgradeInsecureRequests` in the built
`bootstrap.js`, `toTaxonomyGid` in the built connector's create path, `--prod` held.

**The hub moved to production the same day** — Portainer stack on the operator's server,
public at `https://` behind a Cloudflare tunnel on the **store's** account, with a live
`ORDERS_CREATE` webhook registered with the hub app's own credentials, so sales now reach
the ledger automatically. Deployment specifics (host, hostname, subscription id, the
pg_dump migration, and the dead local containers that must never be restarted with workers
on) are deliberately in the untracked memory notes and `private/production/`, not here —
same rule as shop domains. The first product created by the full rules engine (a One Piece
single) came out with every rule applied: vendor, game metafield, tags, category and both
sales channels.

### v0.6.0 (2026-08-08)

Tagged at `7d2a8c6` (the "Prepare v0.6.0" merge, #86). Multi-arch image at
`ghcr.io/collectorscampus/multi-channel-inventory-hub`, tagged `0.6.0`, `0.6` and `latest` —
all three at digest `sha256:6446ac38…`, replacing v0.5.0's `sha256:7eb1b26a…`. Everything from
#85: the **listing rules engine** (a created product's vendor, `custom.game`/`custom.set` and
sales channels now come from per-card rules the same way tags do — `vendorRules`,
`metafieldRules`, `publications`, plus the SDK `listing.publications` capability and Shopify
publish-on-create), **higher-resolution catalogue images** from all three sources, and
**inventory-list usability** (editable On Hand with staged apply, a persisted in-stock filter).
**No schema migration since v0.4.0** — a clean upgrade.

Verified the established way — anonymous registry token first, then inside the pulled artifact:

- **Anonymously**, `0.6.0`, `0.6` and `latest` resolve to the one digest above, and the index
  carries real `linux/amd64` and `linux/arm64` children (plus the two attestation manifests, so
  a naive `platform.architecture` filter still finds two `unknown/unknown`).
- **Inside the image**: `apps/api/package.json` reads `0.6.0`; `listing.publications` /
  `listPublications` is present in **both** `apps/api/dist` and `packages/connector-shopify/dist`
  (so the capability genuinely shipped, not only `main`), and `resolveVendor`/`resolveMetafields`
  are in the built `listing-defaults.js`. `--prod` held: zero `vite`, `vitest` or `esbuild`.

Three things worth not re-deriving, all specific to this release:

- **The local Docker build was broken this session** and CI was the way out. After the operator
  updated Docker Desktop, `docker build` **core-dumped three times at three different stages**
  (`prisma generate` SIGSEGV/exit 139 and SIGILL/exit 132, `nest build` SIGTRAP/exit 133) — an
  unstable build VM emitting "Illegal instruction", not a code fault. The identical build passed
  in CI (the `Docker image builds` job, ~1 min), which is the proof it was environmental. **When
  the local build VM is unstable, push a branch and let CI build** rather than fighting retries.
- **Host-run is the fallback for live verification when no image will build.** The new API was
  run straight from the host (`node apps/api/dist/main.js`, `RUN_WORKERS_IN_PROCESS=false`)
  against the **real compose DB** reached over two throwaway `socat` port-forward containers
  (`alpine/socat tcp-listen:5432,fork tcp-connect:postgres:5432`, and 6379). Native modules work
  on the host — the 685-test api suite already runs there — so the whole server boots. Through it,
  `listPublications` returned all four store sales channels using the hub's own client-credentials
  token, which is the **proof the operator's `read_publications`/`write_publications` scope add +
  reinstall took** (the same "releasing is not installing" gate as `read_metaobjects`).
- **`Publication.name` is deprecated** in the `2026-07` schema (the Catalog interface's `title`
  is the replacement), but `title` is not queryable on `Publication` directly and `name` is still
  valid in the pinned version, so the connector keeps `name` with a note. `publishablePublish`
  needs `write_publications`; the `publications` read needs `read_publications`.

### v0.5.0 (2026-08-07)

Tagged at `4da349f` (the "Prepare v0.5.0" merge, #83). Multi-arch image at
`ghcr.io/collectorscampus/multi-channel-inventory-hub`, tagged `0.5.0`, `0.5` and `latest` —
all three at digest `sha256:7eb1b26a…`, replacing v0.4.0's `sha256:d6a040cd…`. Everything
from #63 to #82: the CardTrader catalogue source (#77), the reconcile report's product names
and correct-the-ledger control (#81), the three dependency majors (bullmq 6, vitest 4,
eslint-config-prettier 10) and two security advisories, plus the catalogue tooling (SSO from
Settings, catalogue clear, grouped ingest) and the intake price. **No schema migration since
v0.4.0** — a clean upgrade, and the release notes and CHANGELOG both say so.

Verified the established way — anonymous registry token first, then inside the pulled
artifact, never trusting the workflow's green tick:

- **Anonymously**, `0.5.0`, `0.5` and `latest` resolve to the **one** digest above, and the
  `0.5.0` index carries real `linux/amd64` and `linux/arm64` children (plus the two
  attestation manifests, which is why a naive `platform.architecture` filter finds two
  `unknown/unknown`).
- **Inside the image**: `apps/api/package.json` reads `0.5.0`; `packages/catalog-cardtrader/dist`
  is present and the built API carries the new `/inventory/:id/quantity` route — so the two
  headline features genuinely shipped in the artifact rather than only living on `main`.
  `bullmq@6.0.8` is the single copy in `node_modules/.pnpm`, proving the major reached the
  runtime tree. And `--prod` held: zero `vite`, `vitest` or `esbuild` in the image.

Two things not re-derived from earlier releases: `gh release create --notes-file` handles the
CHANGELOG's em dashes correctly (only `gh --title` from bash mangles non-ASCII, so the
release **title** uses a plain hyphen), and pushing the `v*.*.*` tag is the sole trigger for
`release.yml` — the "Prepare" PR merging does nothing on its own.

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
2. **`listing.export` is a _price_ export and deliberately moves no stock.** See "Upload
   semantics" below for why: TCGPlayer's CSV can only add to or subtract from a quantity,
   never set one, and a delta would stop the file being safe to re-upload. Prices are
   absolute and idempotent, so those are what it carries. Quantity flows the other way —
   `inventory.import` plus reconciliation reports where the two disagree.

### Shopify authentication changed under us (2026-07-29)

**Shopify retired legacy custom apps on 1 January 2026.** There is no longer a permanent
Admin API token to paste into a settings form, and the "Develop apps" option is gone from
the store admin. Apps are built in the **Dev Dashboard**, and one for a store you own
authenticates with the OAuth **client credentials** grant.

This is the same shape as ADR 0002: a platform's access model moved under an assumption
the design was resting on. It is smaller only because the SDK seam absorbed it — nothing
outside `connector-shopify` changed except the fields an operator fills in.

- **`accessToken` is gone; `clientId` (config) + `clientSecret` (secret) replace it.**
  `POST https://{shop}/admin/oauth/access_token`, form-encoded,
  `grant_type=client_credentials`, answering `{ access_token, scope, expires_in }` with
  `expires_in` always 86399.
- **Tokens expire after 24 hours**, so authentication became state with a clock attached.
  `tokens.ts` caches per channel — two stores are two installations with two secrets —
  refreshes five minutes early so a token cannot lapse mid-push, and collapses a
  concurrent burst onto one request so a cold cache does not get the token endpoint
  throttled. Held in memory only: they are derived data with a one-day life.
- **A 401 mints a fresh token and retries once.** A token can be revoked while still
  inside its lifetime — app reinstalled, scopes changed, secret rotated — and the cached
  copy then looks valid and is not. Once only: if the new token is also refused the
  credentials are wrong and repeating cannot help.
- **Bad credentials are deliberately not retryable.** A wrong secret, an uninstalled app
  and a shop domain that is not ours all fail identically forever, and burning the queue's
  retry budget on them delays everything behind.
- **`webhookSecret` is now optional.** Shopify signs an app's webhooks with that app's
  client secret, so `verifyWebhook` falls back to it; an explicit value still wins, for a
  subscription created by hand.
- **`SHOPIFY_API_VERSION` moved `2025-01` → `2026-07`.** The old pin was roughly 18 months
  old against a platform that supports about a year of versions, so every call would have
  failed with a version error that looks exactly like a credentials problem.

Scopes the connector actually needs, derived from its own documents:
`read_products,write_products,read_inventory,write_inventory,read_locations,read_orders`,
plus **`read_metaobjects`** since `listing.metafields` (#37) — see that section for why it is
the only extra one. Not `write_orders` — §6 is explicit that we never cancel or modify an
order.

**Confirmed against the live store (2026-07-29).** A read-only probe drove the connector's
own client and token source against a real shop. Everything passed:

- The client-credentials exchange returns a `shpat_` token with `expires_in` 86399.
- `2026-07` is a live version, and `fetchLiveState` — the nested
  `inventoryItem → inventoryLevels → quantities(names:["available"])` read with location
  scoping, the most complex query we make — returns what it should.
- `priceToCents` is right on real data: $104.99 → `10499`, $7.99 → `799`.
- The token is cached across calls rather than re-minted.

**The write path is proven too, and cost three schema fixes.** A probe pushed a quantity
and a price to one nominated variant and restored both. Nothing about these was
discoverable without a real store — each one only appeared after the previous was fixed:

1. **`ignoreCompareQuantity` no longer exists** on `InventorySetQuantitiesInput`.
2. **`changeFromQuantity` is required at runtime** although the schema types it nullable.
   It replaced that flag, turning an opt-out into a **mandatory compare-and-swap**. So
   `setQuantity` now reads before it writes, in one query that fetches the inventory item
   id and the current quantity together — reading them separately would open exactly the
   gap the compare exists to close. A stale compare re-reads and retries once; a second
   failure is contention the queue should back off from rather than a loop here.
3. **`@idempotent(key: String!)` is mandatory** on `inventorySetQuantities`. The key is a
   fresh UUID per attempt, not a hash of the operation: a deterministic key would let
   Shopify replay an old result for a genuinely new identical push while the key is still
   in their retention window, which is a silent no-op on someone's stock. The protection a
   stable key would buy is already covered by reading first.

`productVariantsBulkUpdate` was unaffected — `price` is unchanged on
`ProductVariantsBulkInput`.

**Webhooks are proven too, against a real delivery (2026-07-29).** This was the last
unverified assumption in the connector: that Shopify signs an app's webhooks with that
app's **client secret**, so `verifyWebhook`'s fallback from `webhookSecret` is correct. If
it had been wrong, every delivery would have been silently rejected.

The hub was exposed with a `cloudflared` quick tunnel, a `products/update` subscription
registered through the Admin API, and a product's tags touched and immediately reverted.
Two genuine deliveries arrived (`user-agent: Shopify-Captain-Hook`,
`x-shopify-api-version: 2026-07`), both verified, persisted and processed — on a channel
configured with **only** `clientSecret`, so the fallback is what accepted them.

Closed arithmetically rather than by inference: recomputing
`base64(HMAC-SHA256(stored_body, clientSecret))` over the 5170-byte body reproduces the
`x-shopify-hmac-sha256` Shopify sent, exactly. That also proves the stored body is
byte-exact, since a single altered byte would change the digest.

An unsigned POST to the same public URL was rejected 401, so the endpoint is not merely
accepting everything.

Two things worth knowing before repeating this:

- **Registering the subscription needs no extra scope** beyond what the connector already
  declares, and `webhookSubscriptionCreate` accepts the quick-tunnel URL directly.
- **Rotating the client secret takes up to an hour to take effect** on webhook signing,
  per Shopify's documentation. So a rotation is not instantly consistent with verification,
  and deliveries in that window may verify against the _old_ secret.

Two operational notes that cost real time to work out:

1. **Releasing a version is not installing it.** Client credentials fail with "The
   application is not installed on this shop" until you go to the app's **Home** page in
   the Dev Dashboard, scroll down, and use **Install app**. The failure is correctly
   non-retryable, so a channel in this state alerts once rather than retrying into a wall.
2. **`shop.myshopifyDomain` may not be the domain you connected with.** A store can answer
   on both a vanity `<store-name>.myshopify.com` and the permanent, generated
   `<random>-<n>.myshopify.com` that Shopify reports as canonical. Prefer the canonical one
   in channel config: a store-name change would break the alias but never the permanent
   domain. (The operator's real domains are deliberately not written here — see
   `private/shopify.local.json`, which is gitignored.)

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

### Phase 5 so far: alerting

`apps/api/src/sync/alerts.service.ts` is now the **only** writer of alerts, the
way `InventoryService` owns quantities. It was written to fix two real defects,
not as tidying.

- **The inbox was ordered alphabetically.** `orderBy: { severity: 'asc' }` on a
  string sorts `critical, info, warning` — so routine info notices outranked
  every warning, which is the exact inversion the ordering existed to prevent.
  Postgres cannot express a custom order without raw SQL (rule 1), so
  `Alert.severityRank` stores it: critical 0, warning 1, info 2. The migration
  backfills, because defaulting every existing row to warning would have
  silently demoted open criticals. It is a derived column and therefore only
  safe while one writer owns it — hence the service, and a test asserting the
  two can never disagree.
- **Unmapped-listing alerts were unbounded.** The inbound worker called
  `alert.create` per sale, so one unmapped listing that kept selling produced an
  alert per sale — the precise flood the outbound worker's own comment warns
  about, in the file next to it. It is now a flag with an occurrence count.

`raiseFlag` is the "alerts are flags, not tallies" rule made reusable: one open
alert per `(kind, channelInstanceId, source)`, refreshed in place, with the
count kept in context so the detail can still say how often. It replaced two
hand-rolled copies of that logic (outbound, reconcile) and supplied the third.

Two things about it worth not re-deriving:

- **`source` is a discriminator inside `context`, not a column.** Two different
  facts legitimately share a kind — the reconcile sweep and the inbound worker
  both file `reconcile_drift` on the same channel — and each must raise and
  clear without discarding the other. It is filtered in memory because the set
  is bounded by "open alerts of one kind on one channel", which flag semantics
  keep at a handful.
- **Oversells stay one row per occurrence, deliberately.** Each is a different
  customer whose order someone has to deal with, so collapsing them would hide
  work rather than reduce noise. `raise` is for those; `raiseFlag` is for a
  condition that simply stays true.

Severity is refreshed when a flag is re-raised, so a condition that worsens
moves up the inbox instead of staying where it was first filed.

**A new alert kind must be added to `ALERT_KINDS`, and v0.8.0 forgot.** The repricing
sweep raises `reprice_review`, but the kind was never added to the vocabulary in
`packages/db/src/enums.ts` — and the failure is quiet in exactly the way that makes it
survive: `AlertsService.raise` takes `kind: string`, so the alert is written, ordered and
displayed perfectly, while `GET /sync/alerts?kind=…` rejects it with a 400 because
`AlertQueryDto` validates against that list. The inbox looked right; only the filter for
the newest kind was broken, which nobody exercises the day they ship the feature. Fixed
2026-08-13. **When adding an alert kind, extend `ALERT_KINDS` and the `AlertKind` comment
in `schema.prisma` in the same commit** — the enum is the declaration of record, and
nothing in the type system forces the writer to consult it.

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

### Google signed a real user in (2026-08-02)

The first login by a real identity provider, and it needed a code change to be possible at
all.

**Endpoint pinning refused Google outright.** Every discovery endpoint had to share the
issuer's origin, on the reasoning that the flexibility the spec allows "buys a self-hoster
nothing". Google's issuer is `accounts.google.com`, its token endpoint is on
`oauth2.googleapis.com` and its JWKS on `www.googleapis.com` — two of three, refused. It
had gone unnoticed because the fake issuer in the tests is same-origin by construction,
which is exactly what "never tested" was warning about.

Checked before touching the rule: **Entra, Auth0, Keycloak and Okta all keep their
endpoints on the issuer's origin.** Google is the exception, not the norm — so the rule
kept its teeth and gained `OIDC_ALLOWED_ENDPOINT_ORIGINS`, the operator naming the hosts
they accept. The property that mattered survives: the operator decides where the client
secret may go, not the discovery document.

What the live run settled, none of it visible against a fake issuer:

- **`http://localhost:3001/api/auth/oidc/callback` is an acceptable redirect URI to
  Google.** Loopback is exempt from its HTTPS requirement, so a laptop test needs no
  tunnel — unlike the Shopify webhook work, which did.
- **The user is keyed on `sub`, and Google's is a 21-digit number**, not an email. The
  provisioned row carries it in `external_id` with `provider: oidc`, and `username` falls
  back to the email. It is a **separate user** from the local one, which is the point:
  local `nseemann` and the SSO identity coexist, and `OIDC_ALLOW_LOCAL_LOGIN` kept the
  password door open throughout.
- **"First identity becomes admin" did not fire, correctly** — it only triggers at user
  count zero and this instance already had one. The new user took `OIDC_DEFAULT_ROLE`,
  which was set to `admin` for the test. On a real deployment the default is `viewer`, so
  expect the first SSO user to arrive read-only and need promoting.
- **`id_token_signing_alg_values_supported` is `["RS256"]` and there is no
  `end_session_endpoint`** — Google publishes no OIDC logout, so `endSessionEndpoint`
  being optional is load-bearing rather than defensive.
- The consent screen shows an unverified-app interstitial for a Testing-mode client.
  Normal; click through.

**Not proven by this:** role mapping. Google issues no groups, so `OIDC_ROLE_CLAIM` and
`OIDC_ROLE_MAP` remained exercised only against the fake issuer — **until Entra, below.**

### Entra closed the role-mapping gap (2026-08-03)

The last untested part of the OIDC path. A single-tenant app registration with **app roles**
rather than a groups claim, and the difference matters: a groups claim in a cloud-only
tenant emits **group object GUIDs**, so `OIDC_ROLE_MAP` would be keyed on
`{"8f4c…":"admin"}`. An app role's **Value** is a string the operator chooses, so the map
reads as `{"admin":"admin"}`. Prefer app roles.

Setup facts worth not re-deriving:

- **Single tenant, always.** The multi-tenant `common` discovery document declares its
  issuer as the literal `https://login.microsoftonline.com/{tenantid}/v2.0`, braces
  included, and `discovery.ts` compares that against `OIDC_ISSUER_URL` exactly — so
  `common` fails at boot with a mismatch that reads like a typo.
- **Register the redirect URI as `Web`, not `Single-page application`.** The hub is a
  confidential client exchanging the code server-side with a secret; a SPA registration
  makes Entra refuse the exchange.
- **No `OIDC_ALLOWED_ENDPOINT_ORIGINS`.** Measured: all four of Entra's endpoints sit on
  `login.microsoftonline.com`, the issuer's own origin, so the pinning rule passes
  untouched. Entra is the norm the rule was written for; Google is the exception.
- **Entra advertises no `code_challenge_methods_supported`.** Harmless — nothing here
  reads that field and PKCE is always used.
- **App roles are _defined_ under App registrations and _assigned_ under Enterprise
  applications.** Two blades, same app. The Overview's "Managed application in local
  directory" link jumps between them.

**The proof needed a discriminating configuration, and that is the transferable lesson.**
The operator assigned themselves `Hub Viewer` and logged in as `viewer` — which is also
`OIDC_DEFAULT_ROLE`, so the result was consistent with the claim mapping correctly, the
claim matching nothing, _and_ no claim arriving at all. Re-running with
`OIDC_ROLE_MAP={"viewer":"editor"}` and `OIDC_DEFAULT_ROLE=admin` made the three outcomes
disjoint: landing as **editor** was reachable only through the map. It did.

That also confirmed the role is reapplied **in place** on re-login — same `external_id`,
role rewritten — which is what makes revoking access at the IdP take effect here.

**The silent fallback this exposed is now fixed.** An unusable role claim fell back to the
default with nothing logged anywhere, and in the space of two messages both the operator
and the agent drew opposite wrong conclusions from it, because "landed as viewer" looks
identical in all three cases. `roleFromClaims` now warns, and distinguishes **three**
states: claim absent (lists the claim names present, never their values — an ID token
carries name and email), claim present but empty (the subject is in no group), and claim
present but unmapped (logs the values, which are group identifiers rather than personal
data and are the only thing that makes a case mismatch fixable). The empty-versus-absent
split came from reading the test log rather than the green tick — the first version
reported `groups: []` as "no such claim" while listing `groups` among those present.

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
- **A pull sheet ends with a trailer row.** `Orders Contained in Pull Sheet:` in the
  first column, then every order number pipe-separated in what would be Product Name —
  two fields on a line where the others have eleven. It is skipped structurally (no id,
  no quantity, no order column ⇒ not a data row) rather than by matching its wording.
  Reporting it would have put a spurious problem on every real import.
- **Prices carry 2 _or_ 4 decimal places** (`13.33`, `17.0000`). Parse without floats.
- **Quantity 0 rows are normal**, not errors — 563 of 1333 in a real export. They mean
  "priced but not stocked", and reconciliation must not read them as drift.

### Verified against the real exports (2026-07-29)

The connector was run against a genuine Level 4 seller's own files in `private/`,
not just the redacted fixtures. Both now import with **zero problems**:

| Export      | Result                                                                         |
| ----------- | ------------------------------------------------------------------------------ |
| `MyPricing` | 1333 rows → 1333 listings, 0 problems. 563 at quantity 0, exactly as recorded. |
| `PullSheet` | 219 rows → 236 sale events, all keys unique, trailer row skipped.              |

Also confirmed against real data: all **23** distinct condition strings parse, with
none unrecognised and none empty; `Quantity` equals the sum of the `:N` parts in every
row; 218 of 219 pull-sheet ids appear in the pricing export; and 21 product lines span
far more than Magic and Pokémon — One Piece, Lorcana, Flesh & Blood, Union Arena,
Gundam, sleeves, deck boxes and playmats all round-trip.

### The upload path, confirmed against the live account (2026-07-29)

A file generated by `listing.export` was taken through `Import To Staged` on a real
Level 4 account and stopped at Staged. All four validation steps passed — "Headers are
valid", "5 records processed", "No duplicates exist", "Validated 5 records" — followed by
"5 products were successfully imported."

What that settles, beyond the documentation:

- **Our emitted file is accepted as-is.** All 16 columns in that order, every value
  quoted, header row bare, CRLF endings. No reformatting needed.
- **`Add to Quantity` is rendered by their UI as `+/- Qty.`** — the label states the delta
  semantics outright. All five rows showed `0`, and `Total Qty.` stayed `0`, so the export
  is confirmed to move no stock.
- **Prices round-trip exactly.** The staged view shows each price with `(Live: $x.xx)`
  beneath it, and ours matched to the cent.
- **They match on `TCGplayer Id` alone and render their own catalog data** for name, set,
  rarity and condition. Our values are accepted but not authoritative, so a stale name in
  our catalog cannot mislabel someone's listing.
- Staged inventory has its own `Export From Staged` button alongside `Export From Live`,
  and its own `Delete Staged Inventory`. Note the documentation's warning: staged can also
  hold items returned by the refund flow's "Adjust Inventory", so clearing it wholesale is
  not always safe.

### Upload semantics (from TCGPlayer's own documentation, read 2026-07-29)

Settled by the Level 4 seller help pages, not by experiment. Sources: _Importing and
Exporting CSVs to Mass Update Prices and Quantities_, _Using Our Pricing Tools_, and
_How do I clear my live inventory_.

- **`Add to Quantity` is the only editable quantity field, and it is a _delta_.**
  Verbatim: "A positive number will add that amount to your quantity. A 0 will result in
  no changes to your quantity. If you place a negative number in this field, it will
  remove that amount from your existing quantity." Quantity floors at 0.
- **`Total Quantity` is reference-only.** It sits under a heading reading "Do not change
  any of the values in the columns underneath these headings." There is **no way to set
  an absolute quantity by CSV.** Our export writes the desired quantity there and `0` to
  `Add to Quantity`, so today it changes nothing at all.
- **`TCG Marketplace Price` is required and must be ≥ 0.01.** Our export emits an empty
  string for an unpriced allocation, which fails their validation — a real bug.
- **Import merges; it never replaces.** Rows absent from the file are untouched. Clearing
  is a separate `Delete Inventory` action behind a product-line/set picker and an email
  confirmation. The fear that a one-row test file could zero an inventory was unfounded.
- **There is a staging and preview flow.** `Import To Staged` validates headers, records
  and duplicates, then `Save Updates`, and only an explicit `Move to Live` commits.
  Testing against a real account is therefore safe if you stop at staged.
- **Duplicate `TCGplayer Id` values are rejected** for the whole file.
- **Some accounts carry extra columns:** `My Store Reserve Quantity` and `My Store Price`
  when the My Store channel is on, and `Pending Quantity` appears in their glossary. Add
  these to the connector's `known` set or every such export reports unrecognised columns.

**What the export therefore does.** An additive-only column makes "set the quantity to N"
inexpressible, and a delta (`desired − listedQuantity`) would **not be idempotent** —
uploading the same file twice applies it twice, contradicting the "re-uploading is always
safe" property the design and its UI copy both rest on. So:

- `Add to Quantity` is always the literal `0`, which their documentation defines as "no
  changes to your quantity".
- `TCG Marketplace Price` carries our price. Absolute, idempotent, and a real job on its
  own. An allocation with no price, or under one cent, is **omitted** rather than sent to
  fail their validator.
- `Total Quantity` carries `listedQuantity` — what we believe is already live. It is
  reference-only and ignored on import; writing the _desired_ figure there would read, to
  anyone opening the file in a spreadsheet, as a change that is never going to happen.

Reinstating quantity sync would mean tracking per allocation how much has already been
exported, so a re-upload sends nothing twice. That is a real feature, not a tweak, and it
has not been built.

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
`AlertsService.raiseFlag` is the only way to honour this; `raise` is the deliberate
exception, for facts like an oversell that each need their own resolution.

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
- **`pnpm format:check` is a CI gate and is not covered by `pnpm lint`.** It is the first
  step of the build job, so a Prettier slip fails CI before lint, typecheck or the tests
  ever run — and green local lint/typecheck/test says nothing about it. Run it, or
  `pnpm exec prettier --write <files>`, before pushing.
- **Spec files run sequentially** (`fileParallelism: false`). Several share one database and
  truncate each other's rows in parallel, producing off-by-one flakes that vanish when run
  alone.
- **Contract suites must have teeth.** The SDK's own tests prove a connector that fabricates
  ids, uses unstable idempotency keys, or throws on malformed input _fails_ checks the
  reference implementation passes. A green suite that can't fail is worse than none.
- **Assert the success path, not just rejection.** Webhook ingress had two green tests that
  asserted only `not 403` and `>= 400` — and the harness built the app without `rawBody`,
  so every request died at "Missing request body" before verification ran. Both tests
  passed for a reason unrelated to what they claimed to check, and the endpoint's entire
  accept path was unexercised. `webhook-ingress.spec.ts` now asserts the other direction
  and is mutation-checked both ways. A test that only ever asserts failure will pass on a
  component that cannot succeed.
- **Options passed to `NestFactory.create` cannot live in `configureApp`.** Nest reads them
  while building the application. `NEST_APP_OPTIONS` is exported from `bootstrap.ts` and
  used by main.ts and the tests so they cannot drift again — that drift is what hid the
  above.
- **`apps/api` tests import connectors from `dist/`, not `src/`.** A connector source change
  has no effect on an API test until that package is rebuilt. CI builds packages first so
  it is correct there; locally it is a genuine footgun — a mutation to connector source
  appeared to change nothing until `tsc -p tsconfig.json` was run in the package.
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

- **Windows / PowerShell.** Paths contain a space (`D:\Claude Shopify TCG Project`) — use
  `-LiteralPath`; some deletion commands are blocked by the sandbox.
- **Nothing is on PATH by default in an agent shell.** Prefix commands with
  `$env:PATH = "C:\Program Files\nodejs;$env:PATH"`. `pnpm` is not installed globally:
  reach it via `& "C:\Program Files\nodejs\corepack.cmd" pnpm ...`, or run each package's
  own `node_modules\.bin\{vitest,tsc,prisma}.CMD` directly. `gh` lives at
  `C:\Program Files\GitHub CLI\gh.exe`.
- **`corepack.cmd pnpm` is not enough for recursive scripts.** `pnpm -r test` and the root
  `pnpm test` shell out to a bare `pnpm` for each child invocation, which is not there.
  Write a `pnpm.cmd` shim (`@echo off` + `"C:\Program Files\nodejs\corepack.cmd" pnpm %*`)
  into a scratch directory and prepend that directory to PATH. Use the **PowerShell** tool
  rather than bash, so `.cmd` resolves through PATHEXT.
- `cloudflared` is at `C:\Program Files (x86)\cloudflared\cloudflared.exe` (not on PATH).
  `cloudflared tunnel --url http://localhost:<port> --no-autoupdate`, then read the
  `https://<name>.trycloudflare.com` line out of the log; it takes about 10 seconds.
- **Real marketplace data lives in `private/`**, which is gitignored: the operator's own
  TCGPlayer exports, `shopify.local.json` holding live Shopify credentials, and
  `cardtrader/` — their CardTrader Postman collections. Useful for verifying against
  reality; `ShippingExport` and `PackingSlips` must never be opened, as they carry
  customers' names and addresses.
- **The CardTrader collections embed a live bearer token** and arrived in the repo root, not
  in `private/`. They were moved on 2026-08-03; the token was never committed (the files were
  untracked, and the string appears in no object in history). Its `exp` is **2126**, so it is
  effectively permanent — a leak would not age out. **A Postman export is a credential
  export**: anything downloaded from a platform's docs page goes to `private/` unread until
  it has been checked for an `Authorization` header.
- **`prisma migrate reset` is blocked** for AI agents without explicit per-invocation
  consent passed in `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`. Ask first; do not work
  around it.
- Throwaway services for integration tests are `hub-test-db` on **5433** and
  `hub-test-redis` on **6380** (see the docker commands above). The application's own
  compose stack publishes no host ports, so those two are unambiguous.
- Git identity is set **repo-local**: `collectorscampus <nick@collectorscampus.com>`.
- Docker Desktop has wedged once (container unkillable) and a build segfaulted once
  (exit 139). Both were transient; verification fell back to running the API directly.
- **A container left unkillable by the entrypoint hang (#13) cannot be reaped**, not even
  with `docker rm -f` — the interrupted corepack fetch leaves it uninterruptible. Only a
  Docker Desktop restart clears it, along with any `<hash>_` placeholder beside it. That is
  why local verification has been running on **port 3001** rather than 3000.
- The Dockerfile copies package manifests **one at a time** — a new workspace package needs
  two lines added there or the image build breaks.

---

## Open decisions, not open bugs

Five things are deliberately unfinished — 5 is closed and kept for its constraints. Each is
a choice someone should make rather than
a defect to fix, and none blocks anything else.

1. **TCGPlayer quantity sync does not exist.** The export carries price only, because their
   CSV can express a delta but never an absolute, and a delta is not safe to re-upload.
   Restoring it means tracking per allocation how much has already been sent — a real
   feature, not a tweak. Price sync plus drift reporting may well be enough, given intake
   happens on TCGPlayer's side anyway.
2. **The query console's audit trail is a log line, not a table.** Deliberate; a queryable
   trail needs its own model and retention story.
3. **Which marketplace to connect next.** Candidates and the questions to settle before
   building any of them are in [docs/CONNECTOR_ROADMAP.md](docs/CONNECTOR_ROADMAP.md) —
   eBay, Cardmarket, CardTrader, Mana Pool, CardNexus and others. The first question for
   each is not "is there an API" but "is it open to a new applicant at this account tier",
   which is what ADR 0002 and the Shopify rework both turned on.

   **eBay's gate is not the one we expected** (settled 2026-07-29, #14). The application
   and approval machinery is for the **Buy** APIs; **Sell** gets a self-serve keyset. The
   real gate is the **Marketplace Account Deletion** notification, which needs a public
   HTTPS endpoint — with an exemption for developers who persist no platform user data,
   which this hub has a good claim to.

   **A TCGPlayer seller API key is not obtainable** (confirmed 2026-07-30). ADR 0002's
   file-based connector is **permanent, not provisional**. Do not re-check this.

   **The other candidates were researched on 2026-07-30** and the roadmap now carries the
   answers. Headlines: **CardTrader** is the strongest non-eBay candidate — self-serve
   bearer token, **absolute** quantity setting, signed order webhooks; **Cardmarket** does
   _not_ gate API access on seller tier (the feared blocker is ruled out) but is OAuth 1.0a
   and **delta-only** on quantity, needing a read-then-delta push like Shopify's
   compare-and-swap; **Mana Pool** does have a public API, contradicting "unknown"; and
   **CardNexus** is a real multi-game marketplace that could be a `CatalogSource` _and_ a
   `Connector` in one package. All of it is documentation research — **no credential has
   been obtained and no call made**, which is exactly the evidence that proved insufficient
   for TCGPlayer.

   Note `api.cardmarket.com` now returns **410 Gone**; it moved to `apiv2.cardmarket.com`.

   **The secondary candidates were researched too**, and two were category errors rather
   than access problems. **Whatnot has a real GraphQL seller API that is closed to new
   applicants** — TCGPlayer verbatim, so do not plan around it. **Amazon SP-API is
   reachable** (a private seller app for your own store is self-authorized) but needs a
   Professional account and a reviewed developer profile. **Crystal Commerce and BinderPOS
   are not channels — they are competing hubs**; BinderPOS in particular writes into Shopify
   twice daily, so an operator running both it and this hub would have two systems writing
   one store's inventory. Establish that before pointing the hub at a store. Card Kingdom,
   COMC and Cardsphere are not storefronts and expose no seller API.

   The useful generalisation: candidates sort into **self-serve** (CardTrader, Cardmarket,
   CardNexus, eBay Sell, probably Mana Pool), **application** (Amazon), **closed**
   (TCGPlayer, Whatnot) and **not a channel** — and the bucket predicts the work far better
   than the feature list. Ask what a thing _is_ before asking whether it has an API.

4. **Whether to accept webhooks over a cloud event bus.** Researched 2026-07-30 in
   [docs/WEBHOOK_DELIVERY.md](docs/WEBHOOK_DELIVERY.md). Shopify can deliver to Google
   Pub/Sub or Amazon EventBridge instead of an HTTPS endpoint, using the same
   `webhookSubscriptionCreate` mutation with a different `uri` — and **HMAC verification
   does not apply** to those. The benefit is not the HMAC, which is already built and
   proven; it is that a pull-based consumer needs **no public HTTPS endpoint**, which is the
   hardest deployment prerequisite this software has. The cost is a hard dependency on GCP
   or AWS in self-hosted software. Not adopted. The doc records the shape it should take if
   it ever is.

   Related and already true: **the ingress is not the pipeline.** `ChannelFilesService`
   already writes `WebhookEvent` rows with no HTTP involved, so an alternative ingress is a
   third producer of the same rows, not a second pipeline.

   **Shopify's "app automation tokens" are not relevant** and were checked so nobody checks
   again: they authenticate the Shopify **CLI** in CI/CD to deploy app config and
   extensions, and cannot make an Admin API call. The 24-hour client-credentials token
   machinery in `connector-shopify/src/tokens.ts` stays exactly as it is.

5. **Creating Shopify products for cards the store does not carry yet — CLOSED
   2026-08-01.** Requested by the operator 2026-07-30. Their Shopify holds sealed product
   and a few promos; the ledger will hold singles, and there was no way to get one onto the
   storefront except creating the product by hand first.

   **All of it is on `main`** — the SKU code (#32), `listing.create` (#33), the core
   service, endpoint and screen (#34), and metafields (#37). It stayed open on one thing,
   the add-a-variant path never having met Shopify; **that was settled on 2026-08-01** by a
   single run creating one product with three variants, and the entry is kept only for the
   decisions it settled, which are the constraints any change must preserve:

   - **Selected SKUs only, never automatic.** The operator's constraint, verbatim: it
     "probably shouldn't be automatic to create everything that's in say your tcgplayer
     export". A 1,333-row import must never become 1,333 storefront products, so creation
     is an explicit action over specific SKUs and never a side effect of intake or a push.
   - **The core decides grouping.** Find a sibling allocation for another `Sku` of the same
     `CatalogItem` on this channel and pass its `externalListingId` as `siblingListingId`.
     Deciding two SKUs are the same card is a catalogue judgement, which is the core's
     (rule 6) — and the core still stores no product ids.
   - **It must work from a `Sku` with no `CatalogExternalRef` at all.** The operator notes
     "some won't be listed on TCGPlayer", so title and image fall back to whatever the
     ledger holds. Otherwise the feature covers everything except the cases that most need
     it.
   - **Record the allocation and link it, then let the normal push path set quantity.**
     Creation deliberately sets none.
   - **Tags and metafields come from the operator's pick, never derived** — see the
     collections and metafields sections above, which are the reason.
   - **Sealed and `NA` get no variant option, and no set in the title.** Condition is a
     variant axis only where it is a real choice.

6. **`auth_failure` is a declared alert kind that nothing raises.** Bad credentials surface
   as a generic `sync_failure` warning, so an operator cannot tell "your secret is wrong,
   go fix it" — which fails forever and is deliberately not retried — from "the platform
   hiccuped", which will clear on its own. Separating them properly means the SDK giving
   the core a way to classify a failure as authentication, which is a contract change
   rather than polish, and every connector then has to mean the same thing by it.

## Two live proofs (2026-07-30, evening)

The two cheapest unproven paths were both exercised against the real store. Neither
changed any code; both are recorded here because each surfaced something no test had.

**The first real reconcile caught real drift.** `POST /channels/:id/reconcile` against
the live Shopify channel: **139 checked, 23 quantity drifts, 0 pending, 0 unmanaged**, in
0.75 s, `corrected: 0` (auto-correct off), and one `reconcile_drift` warning flag filed —
"differs on 23 listings". The drift is genuine, not manufactured: every linked allocation
has `listedQuantity` 0 because the hub has never pushed a quantity, while the store
carries real stock. The unguessable finding: **Shopify reports _negative_ available
quantities** (−5 and −17 seen live — oversold/committed stock), the connector passes them
through, and the diff treats them as plain numbers. No probe was needed and nothing was
written to the store.

**`parseWebhook` has now run on a real `orders/create`.** A quick tunnel, an
`ORDERS_CREATE` subscription registered with the hub app's own credentials, and a real
order (#2538, one Paradox Rift Booster Pack) created via a draft order and completed
`paymentPending` — no customer, no email. The delivery arrived signed, verified against
the client-secret fallback, persisted, and processed: one sale event, allocation looked
up, and the **oversell path exercised on real data** — the item held 0, so the movement
was recorded with **`delta` 0, `resulting_on_hand` 0, `reason: sale`, note `#2538`**, and
a critical "Oversold by 1" alert was raised (resolved after verification, since the order
was a test). The subscription was deleted and the tunnel closed afterwards.

Two operational facts from doing it:

- **The hub cannot cancel an order, by design** (no `write_orders`), so a test order must
  be cancelled by the operator in Shopify admin — with restock, since completing the
  draft committed a real unit. Until then the platform's available for that variant reads
  one lower than reconciliation last saw.
- **Driving the local app as an agent needs no password**: sessions are stored as the
  hex SHA-256 of the cookie token, so inserting a row into `sessions` (fresh token,
  `token_hash`, `csrf_token`) and presenting `hub_session=<token>` plus `x-csrf-token`
  on mutating calls is a clean local login that touches no credential.

## What has never been tested

Worth stating plainly, because the README is optimistic by nature:

- **Shopify is proven end to end, with nothing left out** — authentication, the `2026-07`
  schema, `fetchLiveState`, price decoding, location scoping, both mutations writing and
  being read back, signed webhook deliveries for both `products/update` and a real
  **`orders/create`** (above), and the whole inbound sale path down to the oversell
  alert.
- **TCGPlayer is now proven in both directions** — imports against the account's real
  exports, and a generated file accepted through `Import To Staged` on the live account.
  What remains untried is `Move To Live`, which was deliberately not pressed: with
  `Add to Quantity` at 0 and prices identical to live it would have been a no-op, so it
  would have demonstrated nothing that staging did not.
- **MySQL and SQLite are not supported yet.** Only the schema is proven portable; there is
  no migration history for them (ADR 0001 §4).
- **OIDC is proven end to end, with nothing left out.** Google completed a login on
  2026-08-02, and **Microsoft Entra closed the role-mapping half on 2026-08-03**:
  `OIDC_ROLE_CLAIM` and `OIDC_ROLE_MAP` have now driven a real user's role from a real
  provider's app-role claim, reapplied in place on re-login. See the Entra section above
  for the setup facts and for why proving it needed a _discriminating_ configuration —
  the obvious test is ambiguous, because the expected role was also the default.
- **Reconciliation auto-correction has never run live.** The loop itself has now seen a
  real platform disagree and caught it (above), but `reconcileAutoCorrect` is off on the
  live channel, so no drift has ever been corrected by a re-queued push against a real
  store.
- **Matching has produced a live `certain`** — once, on 2026-07-31, through `hub-sku`
  after the re-stamp (above). Everything below `certain` is still what a live run of an
  _unlinked_ set returns: `possible · name-partial`, because store titles are prefixed
  and tcgcsv's are not. Nothing has changed about that half.
- **Creation is proven live in every shape it has**, on 2026-08-01: one product with
  **three variants** — two conditions and a printing of Mega Charizard X ex — created in a
  single run, so the `siblingListingId` add-a-variant path has now met Shopify twice over.
  Quantities (2/1/1) arrived by the normal worker, `custom.game` and `custom.set` are set,
  the category is Gaming Cards, and the draft is still on the store. Nothing about
  creation is untried any more.
- **Notification sinks: email is proven against a real provider, syslog against a real
  socket.** The operator delivered a test email through Cloudflare Email Sending on
  2026-08-12, and the fake-token path proved the transport separately (Cloudflare's own
  `535`, reported honestly rather than as a generic failure). Syslog was proven with a
  real UDP datagram received in-session and TCP framing verified byte-exact — but only
  against a listener on localhost: **no third-party collector has ever received one**,
  so field quirks (rsyslog's framing preferences, a collector that wants RFC 3164) are
  untried.
- **The ledger is production data now, not test stock.** The early note here — "12 real
  singles, treat their quantities as fiction" — described the dev database on 2026-08-01
  and is long superseded: at the v0.7.0 verification production held **23,414 catalog
  items and 218 allocations**, all entered through the production UI, with real orders
  decrementing it since 2026-08-09. Any historical count in this file describes the moment
  it was written; **read the live database before quoting one.**
- **The ingest has still never run at whole-game scale in one go.** The catalogue grew to
  its current size a set at a time through the production UI; no single full-game ingest —
  Magic is 453 groups — has been attempted, so the `maxSets` refusal and the rate limiter
  have not met that load.
