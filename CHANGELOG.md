# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org):
while it is `0.x`, a minor bump may contain breaking changes, and those are called out here.

## [0.9.0] — 2026-08-12

The hub tells you when something needs you. Alerts can reach your email inbox and your log
pipeline, the screens that raise them link straight to the thing they are about, and the
settings and channels pages fold away what you are not working on.

**No schema migration** — a clean drop-in upgrade from 0.8.0.

### Added

- **Email alerts** (Settings → Email alerts). Each new alert at or above a severity
  threshold you pick is emailed over SMTP, and an open alert that _worsens_ is emailed
  again, saying what it was before. Repeats of an open alert are deliberately silent — an
  inbox that hears every occurrence filters the sender; the Activity page keeps the count.
  The password is stored encrypted and never shown again; a test button reports what the
  server actually said. Works with any SMTP provider, including Cloudflare Email Sending
  (port 465, implicit TLS, username `api_token`).
- **Remote syslog** (Settings → Remote syslog). Every alert and completed sync attempt is
  shipped to a collector as RFC 5424 messages with JSON bodies — the Activity page as a
  log stream, over UDP or TCP. Fire-and-forget: a dead collector can never fail the write
  it describes. Container logs are a separate stream; Docker's own syslog logging driver
  covers those with no hub involvement.
- **Alerts link to what they are about.** An unmapped-listing alert resolves the listing
  it names and links to it — by product title, in Shopify admin, and on the storefront
  when published. Channel names on alerts and log rows link to that channel's card.
- **Market price on the item page.** The stored per-printing market figures sit beside
  On hand / Reserved / Pool, with was/now when the figure moved. Filled by the repricing
  sweep, so an unlisted item shows none until it is allocated and swept.
- **Repricing: in-stock-only.** A per-channel toggle so the sweep skips items with
  nothing on hand (oversold-negative counts as out of stock). Market figures are still
  recorded for skipped items; a stale proposal clears when its item sells out.
- **Themes.** Four built-in palettes (Hub blue, Emerald, Violet, Sunset) under
  Settings → Appearance, applied live, each with dark and light variants. Remembered per
  browser, so every person keeps their own. Warnings stay the colour warnings are.

### Changed

- **Settings and channels fold away what you are not working on.** SSO, Email alerts,
  Remote syslog and Clear catalog collapse (closed by default) with their on/off state
  coloured in the closed row; Navigation and Users collapse but start open; Clear catalog
  moved to the very bottom, below Users. Every channel card collapses too, starting open.
- Deployment facts read plainly: "Local login", "Enabled"/"Disabled" for password login,
  and a coloured query-console state.
- Dependencies: the weekly minor/patch group taken (fastify 5.11.3, jose 6.2.8 among
  them); the ioredis 6 and react-table 9 majors assessed and deliberately deferred.

## [0.8.0] — 2026-08-11

Prices follow the market. Current market figures are pulled at least daily for everything
the ledger has allocated, and each channel turns them into asking prices under rules you
set once — automatically for small moves, by your confirmation for big ones.

**Contains a schema migration** (two new tables and one column). The container applies it
automatically at start; the daily sweep schedules itself on first boot (`REPRICE_CRON`,
default 03:30).

### Added

- **Daily market prices.** A scheduled sweep fetches current figures from the catalogue
  sources that publish them (tcgcsv and Scryfall; CardTrader's catalogue carries none) for
  every allocated item, **per printing** — a foil is priced off the foil's market, never
  the plain printing's by fallback — and records them with the previous figure kept, so a
  change reads as was/now.
- **Repricing rules, per channel.** Percent of market per condition (a condition you have
  not declared is **never** repriced — the hub does not invent multipliers), optional
  rounding to .99, a price floor, and a churn guard for sub-cent noise. Applied prices go
  out through the normal push path and land in the sync log.
- **Auto-apply under your threshold, review above it.** `autoApplyMaxPct` is the line:
  moves within it apply on the sweep; bigger ones become proposals on the channel card —
  current → proposed with the market figure and the arithmetic — with Apply and Dismiss
  per row, and an info alert while any wait. No threshold set means everything reviews. A
  dismissal is deliberately not remembered: the next sweep re-proposes what the market
  still says.
- **Sweep now.** The same code as the nightly run, from the channel card, reporting what
  it checked, recorded, applied and queued.

### Changed

- `CatalogCandidate` gains `pricesByPrinting`; the tcgcsv and Scryfall sources fill it.
  Existing consumers of the scalar `marketPrice` are unchanged.

## [0.7.0] — 2026-08-10

The storefront stays true to the shelf. A sold-out single can now unpublish itself, an
outdated product photo can be replaced in bulk, an item links to its pages on the sites
that know it — including your own store — and a Japanese-language copy can finally be
said to be one at intake.

**Contains a schema migration** (one boolean column on channels — the first since
0.4.0). The container applies it automatically at start; nothing manual.

### Added

- **Draft sold-out singles** (opt-in per channel). When a single's advertised quantity is
  pushed to zero, its product is unpublished — but only if the platform itself shows the
  _whole_ product out of stock, so a sibling condition with copies (or stock at a location
  the hub does not manage) keeps it live. Sealed products are never touched. One direction
  only: restocking never re-publishes automatically — nothing should become buyable
  because a background job ran, so you publish it yourself, as with any draft.
- **Re-push catalogue images** to listings the hub already drives, from the channel card:
  pick linked singles, confirm, and each product's photos are replaced with the
  catalogue's current image (add first, delete after, so a product never sits imageless).
  Exists because the catalogue upgraded from thumbnails to full resolution after many
  listings were created. Sealed listings are never offered — their photos are yours.
- **An item links to its pages elsewhere.** External ids on the intake card view and the
  item detail page are now links — TCGplayer, Scryfall, CardTrader — and a listed item
  links to its live page on _your_ storefront (Shopify's own URL, never a constructed
  guess; a draft shows only its admin page) plus the Shopify admin.
- **A language picker at intake**, beside condition and printing. A Japanese-language copy
  of a catalogued card is the same product with `language JA` — the model always supported
  it; the form finally asks. This is what makes Japanese One Piece copies expressible.

### Changed

- The connector contract gains `listing.image` (replace a listing's image),
  `listing.url` (where a listing lives, as URLs) and `listing.status` (publish/unpublish,
  with a platform-side sold-out guard). Existing connectors are unaffected.

## [0.6.1] — 2026-08-09

Two fixes from the first production deployment, both found live. No schema change.

### Fixed

- **The app was a blank white page over plain HTTP on a LAN address.** The API's
  Content-Security-Policy carried helmet's default `upgrade-insecure-requests`, which
  browsers exempt on localhost but honour everywhere else — so the first deployment reached
  at `http://192.168.x.x` had its scripts force-upgraded to https against a server speaking
  http, and nothing rendered. The directive is removed; the CSP is `'self'`-only, so an
  https deployment loses nothing.
- **A created product's category is normalised to a taxonomy GID.** A category stored as the
  bare handle a metafield constraint yields (`ae-2-2-3-2`) was sent to `productCreate`
  verbatim and rejected as an invalid global id, failing the whole creation. Both spellings
  now work.

## [0.6.0] — 2026-08-08

Listing rules grow up. Where a created product used to get only its tags and category from a
channel's rules, it now gets its **vendor**, its **custom fields** and its **sales channels**
the same way — mapped once from facts the ledger already holds, never guessed. Card images
pushed to a storefront are sharper, and the inventory list is easier to drive. No schema
change: a clean upgrade from 0.5.x.

### Added

- **Vendor by rule.** A channel can set a product's vendor from its game (or set, name or
  kind), not just one value for the whole channel — so a store whose publishers differ by game
  (Pokémon vs. Bandai vs. Wizards) comes out right in a mixed batch. The first matching rule
  wins; a flat default covers the rest.
- **Custom fields by rule.** The metafield counterpart of tag rules: `custom.game` follows the
  game, `custom.set` follows the set, each value one **you** picked from the store's own
  vocabulary. A mixed batch gets the right metaobject per card.
- **Publish to sales channels on creation.** A channel can declare which sales channels every
  product it creates is published to (read back from the platform, chosen by you). On Shopify
  this needs the `read_publications` and `write_publications` scopes, and it only ever touches
  a **newly created** product — adding a variant to a product you already curated never
  restamps its channels. A draft stays invisible until you make it active; this only decides
  where it appears then.
- **Higher-resolution catalogue images** from all three sources — Scryfall's `large` over
  `normal`, tcgcsv's full-size over the `_200w` thumbnail, CardTrader's full image over the
  `preview_` crop — so a created product's image is sharper.
- **An editable On Hand column** on the inventory list: type a number, and stage the change;
  stage several rows and apply them together behind a confirmation, through the same path the
  reconciliation control uses. The "in stock only" filter is now remembered across sessions.

### Changed

- **The connector contract gains `listing.publications`** (read the channel's sales channels)
  and `CreateListingRequest.publications`. Existing connectors are unaffected — a connector
  that does not declare it simply is not asked to publish.

No migration. The four migrations are unchanged since 0.4.0.

## [0.5.0] — 2026-08-07

Wider catalogue reach, and a reconciliation report you can act on. CardTrader joins as a
third catalogue source — the first that needs a credential — and its products converge on
the catalogue you already hold rather than duplicating it. The nightly sweep's report now
names each product instead of showing a bare platform id, and where the channel is the one
that is right, you can correct the ledger from the row. No schema change: a clean upgrade
from 0.4.x.

### Added

- **CardTrader as a catalogue source.** Pull-only (no selling yet), behind an API token set
  on the catalogue screen. Its blueprints publish TCGPlayer, Scryfall and Cardmarket ids at
  high coverage across every game, so an ingest converges on existing catalogue items through
  their shared ids **by design** rather than by the luck of two sources agreeing. The first
  catalogue source that needs authentication; credentials are stored in the same encrypted,
  ref-bound store channel secrets use.
- **The reconciliation report names each listing** — product, set and condition — rather than
  identifying a difference only by its platform id (a Shopify `gid://…` says nothing about
  what the product is). The id stays, de-emphasised.
- **Correct the ledger from a reconciliation difference.** Where the channel is the side that
  is right, a quantity difference offers a field — defaulted to the channel's figure, so the
  common case is one click — that sets the item's on-hand and records a `reconcile` stock
  movement. Operator-initiated per row, never automatic; a pooled item then pushes the
  corrected number to its channels through the normal path.
- **A market price when you add a card**, seeding the listing's price from the catalogue at
  intake — a per-_product_ starting point, not an answer.
- **A split catalogue is reported, with a way back.** When two sources with no id in common
  create two items for one real product, the catalogue surfaces the split and offers a merge
  that moves the loser's SKUs and ids onto the winner — refused, with the rows named, if a
  duplicate holds stock or history.
- **Single sign-on is configurable from Settings**, no restart. The catalogue screen groups
  sets by game and can take every listed set in one ingest, and an admin can clear the local
  catalogue (only items no SKU was ever built on) from Settings.
- **A tag rule that matches an item's kind** — single, sealed or other — so singles can be
  tagged as singles.

### Changed

- **`bullmq` to 6.** Its legacy repeatable-jobs API was removed; the nightly reconciliation
  sweep now uses a **job scheduler**. A repeatable registered by a 0.4.x build lives under
  Redis keys v6 cannot see, so the first sweep after upgrade may run once from the old
  schedule before it self-clears — harmless, because the sweep is idempotent. To avoid even
  that, delete the `bull:reconcile:repeat:*` keys before deploying.
- **Catalogue ingest no longer overwrites a name or set another source has already set** — a
  refresh now only fills a blank field. Adding a second ingesting source (CardTrader) would
  otherwise silently re-spell the catalogue in the new source's conventions.
- **`vitest` to 4** and **`eslint-config-prettier` to 10** (development tooling only).
- A role claim from an identity provider that maps to nothing now **says why** — claim
  absent, empty, or unmapped — instead of quietly seating the user as a viewer.

### Fixed

- **Two dependency security advisories**, both refreshed onto patched versions: `fast-uri`
  (backslash host confusion — reachable through Fastify's JSON tooling, though the one
  host-based check here was already safe) and `brace-expansion` (denial of service via
  unbounded expansion — build-time only).

### Notes

- **No schema migration** — a clean upgrade from 0.4.x.
- CardTrader is the only new thing that needs configuring, and only to use it; the two
  bundled catalogue sources are unchanged.

## [0.4.0] — 2026-08-03

The release that makes the daily loop usable: **add a card and put it on the storefront in
one action**, with the channel deciding its tags from rules you set once. It also carries a
fix for a defect that has been in every published image since 0.1.0 — outbound sync stopped
after the first push per item, silently.

### Fixed

- **An allocation pushed to a channel once and then never again.** The outbound queue reuses
  one job id per allocation and operation so a burst of edits collapses into a single job.
  BullMQ enforces that by refusing a job id it already holds — **including one in the
  completed set**, which was retained 500 deep. So the first successful push permanently
  poisoned that allocation's id: every later change was accepted, logged as queued, and
  discarded. There was no error, no failed job and nothing in the alert inbox; the symptom is
  a storefront that syncs once and then quietly goes stale. Present since 0.1.0. **If you run
  any earlier version, this is the upgrade that matters.**
- **The dev-mode toggle changed nothing in the navigation**, because two components each held
  their own copy of the preference and the browser's `storage` event does not fire in the tab
  that caused it.
- Two places caught an error, threw a new one and dropped the original — OIDC discovery,
  where a DNS or TLS failure's detail is all an operator has, and the Shopify category hint.
  Both attach `cause` now.

### Added

- **Take stock in and list it in one step.** `POST /channels/:id/listings/intake`, and a
  "List on" choice on the intake screen. The intake stands even if the listing fails: stock
  on the shelf is a fact, whether a storefront accepted a draft is not.
- **Tag rules per channel.** A created product's tags are decided by rules you set once —
  _game is Pokemon → `Pokémon`_, _set is `ME02: Phantasmal Flames` → `ME02 Phantasmal
Flames`_, _name contains `Elite Trainer Box` → `Elite Trainer Box`_. This replaces a flat
  list per channel, which could only ever be right for a single-game, single-set batch. **The
  hub still never derives a tag**: every value is one you picked from the store's own
  vocabulary, and the rule only says which cards it applies to. Unmapped sets are _suggested_
  from the store's real tag list, and only when exactly one candidate matches — a set the
  store spells two ways produces no suggestion.
- **`autoListNewStock`**, per channel, refused until the channel has been told what a created
  product should carry. Automatic creation with nothing declared would put untagged drafts on
  a storefront at the speed of intake, and on a tag-driven store an untagged product is in no
  collection.
- **User administration** — list, create local accounts, assign roles, activate, reset
  passwords, delete. Two things are refused rather than warned about, because there is no
  undo: you cannot demote, deactivate or delete **yourself**, and the **last active admin** is
  untouchable by anyone.
- **A settings page**, reached from a new account menu, reporting what the deployment is
  running read-only, plus a developer-mode toggle that surfaces the screens normally reached
  from a channel.
- **Click a card's art at intake to see it large** — with the intake form beside it, so
  condition and printing are entered while the picture is still in view. Resolution is the
  point: the stored images are 200px wide, so a higher-resolution variant is substituted
  where the source publishes one, falling back to the stored URL if it does not resolve.
- **An "in stock only" filter** on the inventory browser. Greater than zero, not non-zero: a
  channel may report a negative available quantity for oversold stock.

### Changed

- The allocation editor names the **channel** rather than printing its UUID, shows the price
  with its currency, says whether a listing is attached, and picks a channel from a dropdown
  instead of asking you to type an id that appeared nowhere in the UI. `fixed` and `pooled`
  move behind an "advanced" disclosure, phrased as what they do to the number a customer sees.
- `fastify` to 5.11, pinned through `pnpm.overrides` — without it two copies resolve and the
  plugin types stop matching. `eslint` to 10, `jose` to 6.2.7, and `@types/node` aligned to
  the **24** line, matching the Node the image actually runs rather than the newest published.

### Notes

- **One migration**, adding two columns to `channel_instances` for the listing defaults.
  Dialect-neutral and validated against all three targets.
- Nothing here lists anything on a marketplace on its own. `autoListNewStock` is off by
  default and cannot be switched on until the channel has been configured.

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

[0.5.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.5.0
[0.4.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.4.0
[0.3.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.3.0
[0.2.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.2.0
[0.1.1]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.1
[0.1.0]: https://github.com/CollectorsCampus/multi-channel-inventory-hub/releases/tag/v0.1.0
