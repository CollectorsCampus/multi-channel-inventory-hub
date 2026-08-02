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
| 5     | Reconciliation, alerting polish, query console, OIDC, release           | Done — **v0.2.0 released 2026-07-30** |

Everything in "After v0.1.1" below shipped in **v0.2.0**: the container-start fix, the
tcgcsv catalog source, and the match-proposal workflow. The section keeps that heading
because it explains _why_ each landed, which the CHANGELOG does not.

`main` is green: **882 tests** (api 516, shopify 125, tcgplayer 102, sdk 61, tcgcsv 45,
scryfall 26, db 7), lint/typecheck/format/build clean. **Five jobs run on a push** —
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
turned a store the hub could not touch into one it can enumerate and link. (PRs #21–#30,
below, landed _after_ the v0.2.0 tag and are in no released image.)

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

### After v0.2.0 — PRs #21–#37 (2026-07-30 to 08-01), on `main`, in no released image

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

### Unmerged work

None. `listing.metafields` merged as **#37** on 2026-08-01, carrying the three decisions
the operator made while it was open — sealed gets no variant option, `NA` with it, and the
set is appended to a single's title only. The two draft products it was demonstrated on
were deleted afterwards and their ledger rows zeroed.

#26 was reviewed and merged on 2026-07-30 with the cross-source guard above added
during review. `shopify-client-credentials` was merged on 2026-07-29 once webhook
delivery was proven against the live store (below), which was the one thing holding it
back.

`main` may be a few commits ahead of `origin/main` — check before assuming CI has seen the
latest.

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
`read_products,write_products,read_inventory,write_inventory,read_locations,read_orders`.
Not `write_orders` — §6 is explicit that we never cancel or modify an order.

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
`OIDC_ROLE_MAP` remain exercised only against the fake issuer.

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
  TCGPlayer exports, and `shopify.local.json` holding live Shopify credentials. Useful for
  verifying against reality; `ShippingExport` and `PackingSlips` must never be opened, as
  they carry customers' names and addresses.
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

Six things are deliberately unfinished. Each is a choice someone should make rather than
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

5. **Creating Shopify products for cards the store does not carry yet — built, and open on
   one thing only.** Requested by the operator 2026-07-30. Their Shopify holds sealed
   product and a few promos; the ledger will hold singles, and there was no way to get one
   onto the storefront except creating the product by hand first.

   **All of it is on `main`** — the SKU code (#32), `listing.create` (#33), the core
   service, endpoint and screen (#34), and metafields (#37) — and one draft product has
   been created on the real store, verified and deleted (above). **This entry stays open
   for exactly one reason: the add-a-variant path has never met Shopify**, because that
   fires only for a second condition of a card already listed and the ledger holds no
   singles at all. Everything else in the shape has run against the real store. The
   decisions those layers settled, kept because they are the constraints any change must
   preserve:

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
- **A real identity provider has now completed a login** — Google, 2026-08-02, see
  below. What is still unproven is a provider that issues **group or role claims**:
  `OIDC_ROLE_CLAIM` and `OIDC_ROLE_MAP` have never been exercised against a real one,
  because Google issues nothing of the kind. Keycloak or Entra would test that half.
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
- **The ledger now holds 12 real singles** across Pokémon, Magic and One Piece, five
  conditions and two printings, ingested from tcgcsv on 2026-08-01 (Bloomburrow 472 cards,
  Romance Dawn 163). Three of them are listed; the rest are test stock nobody means to
  sell, so treat their quantities as fiction.
- **The ingest has never run at catalogue scale.** #24 built the bulk path and 27 Pokémon
  sets (433 items) have been through it, but no full-game ingest — Magic is 453 groups —
  has ever run.
