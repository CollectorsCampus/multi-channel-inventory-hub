# Connector roadmap — marketplaces to research

Candidate channels, and what needs establishing before any of them is worth building.

**Nothing here has been verified.** It is prior knowledge current to roughly mid-2026,
recorded so research starts from a position rather than a blank page. Every confidence
marker below is a claim to check, not a fact to build on.

## Establish the access model first — always

Two of this project's largest course corrections were platforms moving their access model
under an assumption the design rested on:

- **TCGPlayer closed its developer programme to new applicants** ([ADR 0002](adr/0002-tcgplayer-without-an-api.md)),
  which turned a continuous-sync connector into a file-based one.
- **Shopify retired legacy custom apps on 1 January 2026**, which replaced a pasted token
  with the OAuth client-credentials grant.

So the first question for every candidate is not "does it have an API" but **"is that API
open to a new applicant today, at my account tier, and what does approval take?"** A
documented API that requires a commercial agreement, a partner review, or a seller tier the
operator does not hold is, in practice, no API.

**A closed API is not a dead end.** `connector-tcgplayer` proves a `manual` channel —
CSV export/import through `listing.export`, `orders.import` and `inventory.import` — is a
real, working integration. If a marketplace offers seller CSV exports, that is a viable
connector, and the SDK and channel UI already support it with no core changes.

## What to answer for each candidate

Before writing code, a candidate should have all of these settled:

1. **Access** — open registration, or application/partner review? Any seller-tier gate?
2. **Auth** — OAuth 2.0, OAuth 1.0a, static key, or something bespoke? Token lifetime?
3. **Quantity** — can it _set_ an absolute quantity, or only apply a delta? (TCGPlayer's
   delta-only CSV is exactly why quantity sync does not exist there — a delta is not safe
   to re-upload.)
4. **Orders** — webhooks, a polling endpoint, or a file? Is there a stable per-line-item id
   for idempotency?
5. **Live state** — can it report current quantity per listing, for reconciliation?
6. **Identity** — is there a SKU-level id (condition/printing/language), or only a
   product-level one? Our `Sku` is `condition` + `printing` + `language`; a platform that
   models edition or finish separately needs the composite-token treatment TCGPlayer got.
7. **Rate limits** — calls/second and any daily quota, so `MinIntervalLimiter` can be set.
8. **Sandbox** — is there a test environment, or does verification mean touching a live
   storefront?

---

## Candidates

### eBay — _highest expected value; access model researched_

**Confidence: high that a suitable API exists, and high that it is open to us.**

- Sell APIs cover the shape we need: an Inventory API for offers and quantities, a
  Fulfillment API for orders, and an Account API. OAuth 2.0.
- Believed to support **bulk price and quantity update**, which maps directly onto our push
  model, and an event/notification mechanism for order events — so a continuous-sync
  connector with real webhooks looks plausible.
- **Note the ownership:** eBay acquired TCGplayer in 2022, so the two are the same corporate
  parent. Worth knowing when reasoning about why TCGplayer's programme closed, and whether
  eBay's own access is likely to follow.
- **Modelling risk:** eBay listings are listing-centric with variations, which may not map
  cleanly onto our SKU-per-condition model. Settle question 6 above early — this is the part
  most likely to be awkward.

#### The access gate, researched 2026-07-29 — _not_ what this document assumed

This section previously said to expect "a production keyset that needs an application review"
and called that review "the gate to confirm first". From eBay's published documentation, that
is **the wrong gate**, and it is pointing at the wrong API family.

**The approval machinery applies to the Buy APIs, not the Sell APIs.** The alarming language —
eBay Partner Network membership, "no guarantee that your application for production use will
be approved", a mandatory Application Growth Check before production — is written about the
**Buy** APIs, which are for partners building shopping experiences. This connector needs
**Sell**: Inventory, Fulfillment, Account. Those are documented as a self-serve production
keyset. So on present evidence eBay is **nothing like ADR 0002** — the door is open, and the
reason to be careful is different.

**The actual gate is the Marketplace Account Deletion/Closure notification**, and it is a
configuration step rather than a review. Every third-party developer must either subscribe to
it or formally opt out **before their first production API call**; the keyset stays inactive
until one of the two is done. Subscribing means standing up an endpoint that:

- is reachable over **public HTTPS** — the documentation explicitly forbids `localhost` and
  internal IP addresses;
- answers a `GET ?challenge_code=…` with a hash of the challenge code, a verification token
  and the endpoint URL, before eBay will accept it.

**That is a genuine problem for self-hosted software, and it is the thing to settle.** It is
the Shopify webhook shape again, but worse: there, a tunnel was a convenience for testing an
optional feature, and here a publicly routable HTTPS endpoint is a precondition for the
credential working at all. Requiring every operator to expose one before they can sync a
single listing is a serious onboarding cost for a product whose whole premise is that you run
it yourself.

**The opt-out is the escape hatch, and we have an unusually good claim to it.** eBay grants an
exemption to developers who do not persist eBay user data — the portal has a "Not persisting
eBay data" toggle and an exemption reason. This hub already refuses to ingest customer
identity on principle: ADR 0002's TCGPlayer work bans `ShippingExport` and `PackingSlips`
outright because they carry names and postal addresses. An eBay connector built to the same
rule would take an order id, its line items and their quantities — everything allocation
needs — and no buyer PII, because **the hub does not fulfil orders, it only decrements
stock.**

So the question to settle before writing code is a design decision, not a research task:
**can the connector be specified to persist no eBay user data at all, and is that enough for
eBay to grant the exemption?** If yes, the public-endpoint requirement disappears and eBay
becomes the easiest connector yet. If no, the connector needs a story for exposing an endpoint
that most self-hosters will not have, and that story should exist before any code does.

Two caveats on the above, stated plainly because they are not verified:

- **Exemption eligibility is eBay's call, not ours.** Community threads show developers being
  asked to justify it and not always succeeding. The argument above is a good one; it is not a
  guarantee, and nobody has filed it.
- **Nothing here has been tested against a real account.** This is documentation research
  only. The first real step is a developer account and a **Sandbox** keyset, which needs none
  of the above — build and prove the whole connector in Sandbox, then deal with the
  notification question at the point of going live. That ordering also matches eBay's own
  expectation that a selling application demonstrate its end-to-end flow in Sandbox.

**One capacity note for later:** the default keyset is documented around **5,000 calls/day**,
with more available only after the Application Growth Check. For a continuous-sync product
that is a real ceiling worth sizing against expected listing counts, and it is the one place
the Growth Check does become our problem.

### Cardmarket (MKM) — _biggest European reach_

**Confidence: medium-high that an API exists; medium on the access terms.**

- Believed to be API 2.0 using **OAuth 1.0a signed requests** — unusual, and older tooling
  than OAuth 2.0, so budget time for the signing implementation. Responses believed to be
  XML rather than JSON.
- Believed to have **tiered access**, with fuller API access historically limited to
  commercial or higher-tier seller accounts. **This is the thing to confirm first** — it is
  the same shape as the TCGPlayer problem.
- Dominant for Magic and Pokémon in Europe, so this is the single biggest reach extension
  after eBay.

### CardTrader — _worth adding to the list_

**Confidence: medium.** Not on the original list, but it belongs there.

- European marketplace with what is believed to be a public, token-authenticated API, and a
  connected-inventory programme that implies machine access is expected rather than
  grudging.
- Likely the **lowest-friction European option** if Cardmarket's tiering proves restrictive.

### Mana Pool — _research needed_

**Confidence: low.**

- US Magic marketplace, relatively new, positioned around lower seller fees.
- **Whether a public seller API exists is genuinely unknown to me.** Do not assume either
  way. Start with their seller documentation and support, and ask directly about
  programmatic inventory and order access.
- Being newer cuts both ways: possibly more willing to work with an integrator, possibly no
  API at all yet.

### CardNexus — _research needed, including what it is_

**Confidence: low.**

- **Confirm the entity first.** Establish whether this is a marketplace where the operator
  can hold seller inventory, an aggregator or price index, or something else — the right
  integration shape depends entirely on that, and a price index would be a _catalog source_,
  not a connector. Those are deliberately different interfaces here: a catalog source has no
  listings, no orders and no place in the allocation loop.

### Others worth considering

Not requested, listed because they plausibly fit a card seller's mix:

| Candidate            | Why                                      | Expected shape                                  |
| -------------------- | ---------------------------------------- | ----------------------------------------------- |
| **Amazon (SP-API)**  | Large, and cards do sell there           | Real API; heavy onboarding and strict metrics   |
| **Whatnot**          | Dominant for live card breaks            | Likely partner-only access, if any              |
| **Card Kingdom**     | Major buylist                            | Buylist, not seller inventory — different model |
| **Crystal Commerce** | Platform many game stores already run on | Has an API; integration is with the platform    |
| **BinderPOS**        | Shopify-based POS used by card stores    | May be reachable through the Shopify connector  |
| **Cardsphere**       | MTG trade/credit platform                | Not a storefront; different model entirely      |
| **COMC**             | Sports-card consignment                  | Consignment, so allocation semantics differ     |

The last column matters: **buylist, consignment and trade platforms are not storefronts.**
Our allocation model assumes we hold stock and list it. A consignment platform that takes
physical possession, or a buylist that quotes prices rather than accepting listings, does
not fit `fixed`/`pooled` allocation and would need its own thinking before any connector.

## Suggested order

1. **eBay** — largest reach, most likely to have a genuinely usable API, and the strongest
   test of whether the connector SDK generalises past Shopify. Everything so far has been
   built against one continuous-sync platform, so the second one is where the seam either
   holds or does not. **The access research is done** (2026-07-29): the Sell APIs are
   self-serve, so the feared approval gate does not apply, and the real blocker is the account
   deletion notification's public-HTTPS endpoint — which the persistence exemption may remove
   entirely. Start in **Sandbox**, which needs none of it.
2. **Cardmarket or CardTrader** — European reach. Do the access research for both before
   picking, since the answer to "is it open to us" should decide it rather than feature
   lists.
3. **Mana Pool** — cheap to research, and a fast no if there is no API.
4. **CardNexus** — establish what it is before spending more on it.

A useful side effect of doing eBay second-after-Shopify: anything that has to change in
`packages/connector-sdk` to accommodate it is a genuine finding about the abstraction, and
much cheaper to learn now than after four connectors depend on it.
