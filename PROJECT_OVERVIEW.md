# Project Overview — Multi-Channel Inventory Hub

_Working title — rename as desired. Audience: executives, project managers, and other non-technical stakeholders._

---

## The Problem

Sellers of trading cards and collectibles often sell in more than one place at once — for example, a Shopify web store and the TCGPlayer marketplace. Today, keeping those two storefronts in sync is manual, error-prone work:

- When an item sells on one platform, someone has to remember to reduce the quantity on the other. If they forget, the item can be sold twice ("overselling"), leading to canceled orders, refunds, and marketplace penalties.
- There is no single place to see everything the business owns. Some stock may be listed on one platform, some on both, and some may not be listed anywhere yet (new purchases, items being graded, reserved stock).
- Existing commercial tools that solve this charge significant monthly fees and lock sellers into their platform.

## The Solution

We are building an open-source application that acts as the **single source of truth** for inventory. Think of it as a central warehouse ledger:

- **Every item the business owns lives in one central pool.** From that pool, quantities are _allocated_ out to sales channels — some to Shopify, some to TCGPlayer, and some held back and listed nowhere.
- **Each channel gets its own quantity and its own price.** You might own 10 copies of a card, list 6 on TCGPlayer at one price, 3 on Shopify at another, and hold 1 back.
- **Or share the same stock across every channel.** Alternatively, an item can be set to "mirror" mode: all 10 copies are listed on both platforms at once, and a sale anywhere instantly reduces the count everywhere. Each channel can also be given a limit — for example, list all 10 on TCGPlayer but never more than 5 on Shopify — which quietly keeps stock in reserve.
- **When something sells anywhere, the system reacts automatically.** The sale reduces the central pool and the other channels are updated within moments, preventing overselling without anyone lifting a finger.
- **A web dashboard** lets staff view the full inventory, see where everything is allocated, add new stock, adjust quantities and prices, and investigate any sync issues.

## What Makes This Project Different

1. **Open source and free.** The code will live on GitHub for anyone to use, self-host, and improve. Commercial alternatives in this space charge thousands of dollars per year.
2. **Platform agnostic by design.** Shopify and TCGPlayer are just the first two "connectors." The system is built so the community can add new marketplaces — eBay, Square, Cardmarket, and others — without changing the core application.
3. **Bring your own database.** It runs on Postgres out of the box, but is designed to work with other popular databases (MySQL and others) so adopters can use what they already have.
4. **You own your data and your accounts.** The app connects using _your_ seller credentials. No middleman resells your inventory or sits between you and your money.

## How It Works (In Plain Terms)

```
                    ┌────────────────────────┐
                    │   Central Inventory     │
                    │  (the source of truth)  │
                    └───────────┬────────────┘
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
        ┌──────────┐      ┌───────────┐     ┌──────────┐
        │ Shopify  │      │ TCGPlayer │     │ Held back │
        │ 6 listed │      │ 3 listed  │     │ 1 unlisted│
        └──────────┘      └───────────┘     └──────────┘
```

A sale on any channel flows back to the center, and the center pushes updated quantities out to every other channel. A nightly "reconciliation" check compares our records against what each platform actually shows, and raises an alert if anything drifted — so mistakes are caught, never hidden.

## Scope

**In scope (initial releases):**

- Central inventory with per-channel quantities and per-channel pricing
- Shopify connector (full two-way sync)
- TCGPlayer connector (full two-way sync, pending their API approval — see Risks)
- Web dashboard: view, search, add, and edit inventory; user login; role-based permissions
- Docker-based installation so anyone can self-host it easily

**Out of scope (for now):**

- Point-of-sale / in-person register features
- Shipping label generation and order fulfillment workflows
- Automated repricing based on market data (a natural future add-on)
- Hosting the app as a paid service for others

## Rough Phases

| Phase | What gets delivered                                                 | Depends on                 |
| ----- | ------------------------------------------------------------------- | -------------------------- |
| 1     | Core inventory system + web dashboard (no external syncing yet)     | —                          |
| 2     | Card catalog lookups and market-price reference data                | —                          |
| 3     | Full Shopify sync (two-way)                                         | Phase 1                    |
| 4     | Full TCGPlayer sync (two-way)                                       | **TCGPlayer API approval** |
| 5     | Reconciliation, alerting, and polish for public open-source release | Phases 3–4                 |

## Key Risks

- **TCGPlayer API access is not automatic.** It requires a TCGPlayer Pro seller account and an application/approval process that we do not control the timeline on. _Mitigation:_ the application is submitted at project start, and all other phases are deliberately sequenced so work never waits on it. A fully useful Shopify + inventory product exists even before approval arrives.
- **Marketplace APIs change.** Shopify and TCGPlayer both evolve their systems. _Mitigation:_ the connector design isolates each platform's quirks in one small module, so changes are cheap to absorb.
- **Overselling during sync gaps.** No sync is truly instantaneous. _Mitigation:_ the system decrements stock immediately on any sale signal, treats channels as "eventually consistent," and alerts a human the moment records disagree rather than guessing.

## Success Criteria

- Zero silent sync failures: every discrepancy between our ledger and a live channel is surfaced as an alert within one reconciliation cycle.
- A new user can go from "cloned the GitHub repo" to "running dashboard" with a single Docker command.
- A developer can build a new marketplace connector using only the documented connector interface, without touching core code.
