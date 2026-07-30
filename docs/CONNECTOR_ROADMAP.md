# Connector roadmap — marketplaces to research

Candidate channels, and what needs establishing before any of them is worth building.

**Sections dated "researched &lt;date&gt;" have been checked against the platforms' own
documentation. Everything else is prior knowledge** current to roughly mid-2026, recorded so
research starts from a position rather than a blank page — a claim to check, not a fact to
build on.

Even the researched sections stop at documentation. **No credential has been obtained and no
call made** for any candidate here. That distinction is the whole of ADR 0002: TCGPlayer's
API is thoroughly documented and completely unobtainable. Read "self-serve" below as "the
documentation says self-serve".

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

### Cardmarket (MKM) — _biggest European reach; access researched 2026-07-30_

**Two of this section's original assumptions were wrong.** It previously said access was
believed tiered, "the same shape as the TCGPlayer problem", and that this was the thing to
confirm first. Confirmed, and it is not:

- **No commercial or professional account is required for API access.** Any seller account
  can create an app from its profile page. Tier affects _volume_, not admission: standard
  users get 600 requests/minute and 50,000/day; professionals get 100,000/day with 30,000
  of that capped for marketplace requests.
- **OAuth 1.0a with HMAC-SHA1 signatures is confirmed**, not merely believed — the
  `Authorization` header carries `oauth_consumer_key`, `oauth_token`, `oauth_nonce`,
  `oauth_timestamp`, `oauth_signature_method`, `oauth_version` and `oauth_signature`.
  Budget real time for the signing implementation; nothing else here needs it.
- **The API host has moved.** `api.cardmarket.com` now answers **410 Gone** — it migrated
  to `apiv2.cardmarket.com` (documented deadline 1 May 2026, already past). Anything found
  in an older tutorial points at a dead host.
- **A sandbox exists** at `sandbox.cardmarket.com`, but the documentation itself noted it
  had not been updated for over two years. Treat it as better than nothing, not as a
  faithful mirror.

**The real problem is quantity, and it is the TCGPlayer problem again** (question 3). There
is **no absolute set**. Stock quantity changes only through `PUT /stock/increase` and
`PUT /stock/decrease`, and the ordinary article `PUT` explicitly "can't be used to increase
or decrease the stock's quantity". Up to 100 articles per batch.

**But it is not fatal here, and the difference from TCGPlayer matters.** TCGPlayer's delta
is unusable because the file is prepared offline and must stay safe to re-upload, with no
read at push time. Cardmarket exposes current stock, so a connector can **read the article's
count and compute the delta at push time** — precisely the compare-and-swap
`connector-shopify`'s `setQuantity` already does for `inventorySetQuantities`. That pattern
exists and is proven; this would be its second user.

Two smaller findings: articles model `idLanguage`, `condition`, `isFoil`, `isSigned` and
`isAltered` as **separate fields**, which is a better fit for our `Sku` than TCGPlayer's
four-in-one string and needs no composite-token treatment. And increasing stock can fail
outright because of per-seller-type limits on how many copies of one article may be held —
a failure mode with no analogue in any connector so far.

### CardTrader — _researched 2026-07-30; strongest non-eBay candidate_

**Confidence: high, and it has moved to the front of the queue.**

On documentation alone this is the **best-shaped API of every candidate here**, eBay
included:

- **Self-serve bearer token**, taken from the profile settings page. The documentation
  states no approval step, no tier requirement and no eligibility criteria — though see the
  caveat below.
- **Absolute quantity is supported.** `PUT /products/:id` takes a `quantity` parameter
  directly, with `POST /products/:id/increment` offered separately for relative
  `delta_quantity` changes. That makes it the only candidate researched so far that maps
  onto `listing.quantity` with no delta gymnastics at all.
- **Order webhooks with cryptographic signatures** — "will notify your endpoint whenever an
  Order is created, modified or deleted", configured via profile settings or the `/app`
  endpoint. That is `orders.webhook` plus `verifyWebhook` almost exactly as the SDK already
  shapes them.
- Bulk endpoints (`/products/bulk_create`, `/bulk_update`, `/bulk_destroy`), a CSV path
  (`/product_imports`), and `/products/export` for enumeration — which would satisfy
  `listing.enumerate` and `reconcile` without inventing anything.
- Order management covers ship, tracking code and cancellation, though **§6 says we never
  cancel or modify an order**, so only the read side is in scope.

**The caveat, and it is the one this project keeps learning:** third-party sources describe
API access as available "to active sellers on appropriate plans", which is exactly the kind
of tier gate the documentation does not mention and ADR 0002 exists to remember. **Confirm
against the operator's own account before building.** A token visible in profile settings
would settle it in a minute.

### Mana Pool — _researched 2026-07-30; a public API does exist_

**The previous "genuinely unknown to me" is resolved: there is a public API**, documented at
`manapool.com/api/docs/v1`, and Mana Pool advertises it to sellers directly — "Large stores
with custom backends can also use the Mana Pool API to connect."

- Positioned as an **open** API for developers "whether building tools for your own use or
  creating solutions for other sellers", which is the opposite posture to TCGPlayer's closed
  programme.
- They already integrate Crystal Commerce, CCGSeller and Shopify/BinderPOS, and state
  explicitly that cross-posting to other markets is allowed with **no lock-in** — worth
  noting, because a marketplace that forbids cross-listing would be incompatible with a
  pooled allocation model.
- Magic only, which caps the value for a store whose inventory spans 21 product lines.

**Not yet established:** the authentication method, whether quantity can be set absolutely,
order delivery, and rate limits. The documentation page did not render usefully to an
unauthenticated fetch; read it in a browser, or create a seller account and mint a key.

### CardNexus — _researched 2026-07-30; it is a marketplace, and more_

**The entity question is settled.** CardNexus is a genuine multi-game peer-to-peer
**marketplace** where a seller holds and lists inventory — so it is a connector candidate,
not merely a price index. It is also a collection tracker and a price aggregator drawing on
other marketplaces, spanning 29 countries and 9 currencies.

- **Public API with a single bearer token (an API key)** in the `Authorization` header,
  minted from the account's own API keys section — self-serve on the evidence available.
- Exposes **accounts, inventory, listings, orders, payouts and the catalogue** across Magic,
  Pokémon, One Piece and others, and the documentation has dedicated guides for **webhooks**
  and **rate limits**.
- **It is plausibly both interfaces at once.** The catalogue and aggregated pricing could
  make it a `CatalogSource`, while inventory/listings/orders make it a `Connector`. The SDK
  already contemplates exactly this — a package may export both — so that is a supported
  shape rather than an awkward one. It would also be the first non-TCGPlayer-derived
  catalogue covering more than Magic, which is the gap `catalog-tcgcsv` currently fills
  alone.
- **Unestablished:** absolute vs delta quantity, condition/finish/language modelling, and
  how much seller liquidity actually exists. The last one decides whether any of it is worth
  building.

### Others — _researched 2026-07-30_

This table was previously guesswork. It has been checked, and the guesses were mostly right
about shape and wrong about which ones are reachable.

| Candidate            | Access model, verified                                        | Verdict                               |
| -------------------- | ------------------------------------------------------------- | ------------------------------------- |
| **Whatnot**          | Real GraphQL Seller API — **closed to new applicants**        | Blocked. Watch for it reopening.      |
| **Amazon (SP-API)**  | Open, but Professional account + developer-profile review     | Viable; heaviest onboarding here.     |
| **Crystal Commerce** | Has a JSON API and a partner programme                        | **A competing hub, not a channel.**   |
| **BinderPOS**        | No public API; integrates via its own Shopify app             | **Would collide with us in Shopify.** |
| **Card Kingdom**     | No seller API. Third-party scrapers expose its _prices_ only. | Price data at best, not a channel.    |
| **Cardsphere**       | No public seller API found                                    | Not pursuable.                        |
| **COMC**             | No public seller API found                                    | Not pursuable.                        |

#### Whatnot — the exact ADR 0002 shape, again

The guess was "likely partner-only access, if any". Confirmed, and precisely: the API is
real, GraphQL, with staging (`api.stage.whatnot.com/seller-api/graphql`) and production
endpoints, covering product management and **notifications when products sell** — the two
things a connector needs. Its own documentation then says it is in Developer Preview and
**"not accepting new applicants for access at this time"**, available only to "select beta
partners".

So it is a fully documented, well-shaped, completely unobtainable API. That is TCGPlayer
verbatim. **Do not plan around it**, and do not treat the quality of the documentation as
evidence of availability — that inference is the one this project has now been burned by
twice.

#### Amazon SP-API — open, but the gate is a tier and a review

Reachable, and more so than "heavy onboarding" suggested, because a **private seller
application** for a store you own is _self-authorized_ — no Appstore listing, no public
OAuth flow, no solution-provider agreement. That removes most of the feared weight.

What remains is real: a **Professional selling account** (Individual accounts are not
eligible), being the primary account user, identity verification, and a developer profile
describing the data required and its security handling. It is an application that can be
refused, so it belongs in the "establish access first" bucket rather than the self-serve
one.

#### Crystal Commerce and BinderPOS are not channels — they are us

The most useful correction in this section. Both were listed as integration candidates; both
are **inventory hubs in their own right**, and that changes the question from "can we
connect" to "should we".

- **Crystal Commerce** syncs one inventory across Amazon, eBay and TCGplayer — the same job
  this project does. It has a JSON API and a technology-partner programme, so connecting is
  possible, but it would mean treating Crystal Commerce as the system of record and this hub
  as a client of it. That is a different product.
- **BinderPOS** is a TCG point-of-sale that pushes catalogue and pricing **into Shopify**,
  twice daily, and pulls marketplace orders back. An operator running both it and this hub
  would have **two systems writing the same Shopify inventory**, which is not an integration
  but a race — and precisely the drift reconciliation exists to detect, arriving nightly
  and forever. If the operator uses BinderPOS, that is a fact to establish before pointing
  this hub at the same store, not a connector to build.

#### The rest are not storefronts

Unchanged and still the point: **buylist, consignment and trade platforms are not
storefronts.** Our allocation model assumes we hold stock and list it. Card Kingdom quotes
buylist prices rather than accepting listings, COMC takes physical possession, and
Cardsphere trades on credit. None fits `fixed`/`pooled` allocation, and none of the three
exposes a seller API anyway. Card Kingdom's data is reachable only through third-party
scraping services, which is a licensing question before it is a technical one.

#### One aggregator worth knowing about

**TCGAPIs** is a commercial third-party API unifying catalogue, SKU pricing and listings
across Cardmarket, CardTrader, Mana Pool, Card Kingdom and Cardsphere. That is a
`CatalogSource` shape, not a connector — a possible alternative or complement to
`catalog-tcgcsv`, and the only route found to Cardsphere and Card Kingdom data. It is paid
and third-party, so it trades the tcgcsv problem (a community CDN with no SLA) for a vendor
dependency. Noted, not recommended.

### What the access models actually look like, across everything researched

The single most useful output of this research is that the candidates sort into four
buckets, and the bucket predicts the work far better than the feature list does:

1. **Self-serve today** — CardTrader, Cardmarket, CardNexus, eBay (Sell), and probably Mana
   Pool. A token or key from an account page. Build against these first.
2. **Application with a real chance of refusal** — Amazon SP-API. Professional tier plus a
   reviewed developer profile.
3. **Closed to new applicants** — TCGPlayer and Whatnot. Both fully documented. Both
   unobtainable. File-based connectors or nothing.
4. **Not a channel at all** — Crystal Commerce and BinderPOS (competing hubs), Card Kingdom,
   COMC and Cardsphere (not storefronts), TCGAPIs (a catalogue).

Two of the seven "others" turned out to be category errors rather than access problems,
which is worth remembering when the next name is added to this list: **ask what it is before
asking whether it has an API.**

## Suggested order

1. **eBay** — largest reach, most likely to have a genuinely usable API, and the strongest
   test of whether the connector SDK generalises past Shopify. Everything so far has been
   built against one continuous-sync platform, so the second one is where the seam either
   holds or does not. **The access research is done** (2026-07-29): the Sell APIs are
   self-serve, so the feared approval gate does not apply, and the real blocker is the account
   deletion notification's public-HTTPS endpoint — which the persistence exemption may remove
   entirely. Start in **Sandbox**, which needs none of it.
2. **CardTrader** — this was "Cardmarket or CardTrader, research both first". The research
   is done (2026-07-30) and it separates them clearly. CardTrader has a self-serve bearer
   token, **absolute quantity setting**, signed order webhooks, bulk endpoints and an export
   for enumeration — it maps onto the existing capability set with less adaptation than eBay
   does. The one thing to confirm is the "active sellers on appropriate plans" hint that the
   documentation does not mention.
3. **Cardmarket** — bigger European reach, but more work for it: OAuth 1.0a signing, and
   quantity only through increase/decrease, so a read-then-delta push like
   `connector-shopify`'s compare-and-swap. Admission is _not_ gated on seller tier, which was
   the feared blocker and is now ruled out.
4. **CardNexus** — no longer "establish what it is": it is a multi-game marketplace with a
   self-serve API key covering inventory, listings, orders, webhooks and a catalogue. The
   open question is now commercial, not technical — whether it has enough seller liquidity
   to be worth a connector. It is also the only candidate that could be a `CatalogSource`
   and a `Connector` in one package.
5. **Mana Pool** — a public API exists, so it is no longer a fast no. Magic-only, which caps
   its value against an inventory spanning 21 product lines. Cheap to settle: mint a key and
   read the docs.

**None of the above has been verified by obtaining a credential and making a call.** It is
documentation research, which is exactly the evidence that proved insufficient for
TCGPlayer — a documented API is not an obtainable one. Treat every "self-serve" here as a
claim to test on the operator's own account first, in one sitting, before any code.

A useful side effect of doing eBay second-after-Shopify: anything that has to change in
`packages/connector-sdk` to accommodate it is a genuine finding about the abstraction, and
much cheaper to learn now than after four connectors depend on it.
