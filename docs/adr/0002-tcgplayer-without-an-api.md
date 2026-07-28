# ADR 0002 — TCGPlayer without an API

- **Status:** Accepted
- **Date:** 2026-07-28
- **Supersedes:** the TCGPlayer portions of TECHNICAL_DESIGN.md §5, §11 (Phases 2 and 4) and §12

---

## Context

The plan assumed TCGPlayer API access was a _timing_ problem: apply on day one, sequence
the phases so nothing waits on approval, and the key eventually arrives. §12 records it as
"TCGPlayer API approval timeline is external" and mitigates it by phase ordering.

That assumption is false. TCGPlayer's own developer documentation now states:

> "We are no longer granting new API access at this time. Existing users must adhere to the
> terms of service that govern the use of our API, including, but not limited to important
> restrictions and attributions required by you."

_(Verified directly against <https://docs.tcgplayer.com/docs/getting-started> on 2026-07-28.)_

This is not a queue. eBay-owned TCGPlayer has closed the developer programme to new
applicants; existing keys continue to work and new ones are not issued. The application
this project was told to submit on day one will not be approved, and no amount of phase
reordering changes that.

### What it invalidates

| Assumption                                                       | Status                                          |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| §12: approval is a timeline risk, mitigated by ordering          | **Wrong.** It is a permanent blocker.           |
| §11 Phase 2: "TCGPlayer catalog search (pre-approval endpoints)" | **Dead.** The catalog endpoints need a key too. |
| §11 Phase 4: OAuth, outbound push, inbound polling               | **Dead as written.**                            |
| §5: every connector is an HTTP API client                        | **Too narrow.** See decision 2.                 |
| §4: reuse TCGPlayer product IDs as canonical                     | **Survives**, but needs a new source.           |

Nothing in the _core_ is affected. The ledger, the allocation engine, the invariant and the
inventory API never referenced a connector — which is the design's isolation rule paying
for itself the first time it was tested.

---

## Decision

### 1. The TCGPlayer connector becomes file-based, not API-based

TCGPlayer Pro supports bulk inventory management by CSV upload and export. That is the
supported path for a seller without API access, so the connector's job changes from
"call an API" to "produce a file the operator uploads, and ingest the file they export".

Outbound becomes: render the current allocation as a TCGPlayer-shaped CSV for download.
Inbound becomes: accept an uploaded sales or inventory export and translate it into the
same `NormalizedEvent`s the sync engine already consumes.

This is worse than an API — it is operator-triggered rather than continuous, so the
oversell window widens from minutes to however often a human does the round trip. It is
also the only path that does not depend on TCGPlayer's goodwill or on credentials nobody
can obtain.

### 2. The connector SDK gains a capability class for manual/file channels

**This is the time-sensitive part, and the reason this ADR is written before Phase 2
rather than during Phase 4.**

§5's `Capability` union assumes continuous API access:

```
"catalog.search" | "listing.push" | "listing.price" | "listing.quantity"
| "orders.webhook" | "orders.poll" | "reconcile"
```

A file-based channel supports none of them, yet is a perfectly legitimate connector. The
SDK needs capabilities along the lines of `export.file` and `import.file`, plus a way for
the core to represent "this channel is only as fresh as the last manual sync" — the UI has
to show that, and reconciliation must not treat a stale file-based channel as drift.

Designing this into the SDK from the start costs little. Retrofitting it after two API
connectors have hardened the interface costs a great deal. It also generalises: every
marketplace without an API becomes reachable by the same mechanism, which is worth more to
an open-source project than the TCGPlayer connector itself.

### 3. Catalog data comes from third parties, keyed on TCGPlayer IDs where possible

§4's "reuse canonical platform IDs, don't invent our own" survives; only the source moves.

- **Scryfall** (Magic). Free, documented, no key. Its card objects carry `tcgplayer_id`.
  _Verified 2026-07-28: present on modern cards (Sheoldred → 282800, Lightning Bolt → 697344) but coverage is not universal — 158 of 175 cards on the first page of set `dmu`,
  and absent entirely from the Black Lotus printing returned by `/cards/named`._ Any
  importer must tolerate a missing ID rather than assume one, which means
  `CatalogExternalRef` stays optional per item.

- **pokemontcg.io** (Pokémon). Expected to expose TCGPlayer pricing links.
  _Not verified — the API returned HTTP 500 during evaluation. Confirm before relying on it._

- **tcgcsv.com**. Republishes TCGPlayer catalog and price data as daily CSV/JSON, no auth.
  _Verified 2026-07-28: it is an unofficial third party caching TCGPlayer's API output,
  roughly 24 hours stale, carrying a TCGPlayer affiliate link and making no statement about
  the terms under which it redistributes._ Convenient, and the most direct source of
  TCGPlayer product IDs — but it is one person's redistribution of someone else's API data,
  so it is both a single point of failure and legally unclear. Acceptable as an optional
  importer; not acceptable as the only path.

### 4. Legacy API access stays supported, as an optional capability

Existing keys still work. Sellers who hold one should not be punished for it, and it is the
only way the connector can ever be continuous. The API path therefore remains implemented
and capability-gated: present its credentials and the connector declares the API
capabilities, otherwise it falls back to file-based. This is exactly what the
capabilities-are-declared rule in §5 was for.

### 5. Scraping the front end is rejected as a default

Undocumented endpoints behind tcgplayer.com are widely used and would restore continuous
sync. They are rejected for the shipped default anyway.

This application runs under each self-hoster's _own_ seller credentials. The downside of a
terms-of-service breach is not a failing build — it is somebody's storefront being
suspended and their income stopping. Shipping that behaviour by default in software other
people install makes this project the cause. TCGPlayer's own wording now explicitly binds
users to "important restrictions" on API use, which is not the language of a company
relaxing its enforcement posture.

Nothing prevents an individual from writing such a connector for themselves — the SDK is
public and community connectors are an explicit goal. It will not be one of the bundled
ones.

---

## Consequences

- **Phase 2** loses TCGPlayer catalog search and gains a Scryfall-based importer plus the
  file-capability SDK design. Intake still works; the catalog source changes.
- **Phase 4** changes from "TCGPlayer connector, gated on API approval" to "TCGPlayer
  file-based connector", and is no longer gated on anything external. It could move
  earlier.
- **§12's risk entry is rewritten**: the risk was realised, not mitigated. The correct
  lesson for the risk register is that a dependency on a third party _granting_ access is
  not a schedule risk, it is a design constraint, and should have been treated as one from
  the start.
- **Shopify becomes the only continuous-sync channel in v1.** The product is still coherent
  — the ledger plus Shopify plus a manual TCGPlayer loop is a real improvement on doing it
  by hand — but the "prevent overselling automatically across both channels" promise in
  PROJECT_OVERVIEW.md must be softened for TCGPlayer. That document needs updating; it
  currently promises more than can be delivered.
- **The oversell window for TCGPlayer is now human-paced.** The pessimistic conflict policy
  and oversell alerting in §6 matter more, not less, and the reserve mechanism becomes the
  main defence: holding stock back is how a seller absorbs a sync gap they cannot close.

## Open question

Whether to keep TCGPlayer as a first-class bundled connector at all, or to ship the
file-capability SDK plus Shopify in v1 and let TCGPlayer follow. Deferred until the SDK
exists and the real cost of the CSV round trip is visible.
