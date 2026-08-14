# Connector authoring guide

A connector teaches the hub how to talk to one sales channel. This guide is the
prose; [`@hub/connector-sdk/testing`](../packages/connector-sdk/src/testing.ts) is the
executable version, and it is the one that decides whether your connector is correct.

## The one rule

**Connectors are dumb pipes. The core owns all quantity maths.**

A connector translates between the core's canonical operations and one platform's
interface. It never decides how many units to list, never reads the ledger, and never
resolves a conflict. Requests arrive carrying a quantity the core has already computed
from the allocation rules — use it as given.

If you find yourself deriving a quantity inside a connector, the abstraction has been
breached. Raise an issue rather than working around it.

## Capabilities

Declare what you support; the core degrades around it. A connector without
`orders.webhook` is automatically scheduled for `orders.poll`, and one with neither is a
manual channel whose freshness depends on a human moving files.

| Capability             | Method                             | Meaning                                        |
| ---------------------- | ---------------------------------- | ---------------------------------------------- |
| `listing.push`         | `pushListing`                      | Update an existing listing                     |
| `listing.create`       | `createListing`                    | Bring a listing into existence                 |
| `listing.price`        | `updatePrice`                      | Change a listing's price                       |
| `listing.quantity`     | `updateQuantity`                   | Change advertised quantity                     |
| `listing.delist`       | `delist`                           | Remove a listing                               |
| `listing.enumerate`    | `enumerateListings`                | Report what the channel already sells          |
| `listing.sku`          | `updateListingSku`                 | Write the hub's code into the seller-SKU field |
| `listing.url`          | `listingUrl`                       | Where a listing lives, for a human to open     |
| `listing.status`       | `updateListingStatus`              | Publish or unpublish a listing's product       |
| `listing.image`        | `updateListingImage`               | Replace a listing's imagery                    |
| `listing.tags`         | `listTags`                         | The tag vocabulary the store already uses      |
| `listing.metafields`   | `listMetafields`                   | The custom fields the store models             |
| `listing.publications` | `listPublications`                 | The sales channels a product can go on         |
| `orders.webhook`       | `parseWebhook` (+ `verifyWebhook`) | Platform posts order events to us              |
| `orders.poll`          | `pollChanges`                      | We poll for order events                       |
| `reconcile`            | `fetchLiveState`                   | Fetch live state for drift detection           |
| `listing.export`       | `exportListings`                   | Render listings to a file for manual upload    |
| `orders.import`        | `importOrders`                     | Parse an operator-supplied order export        |
| `inventory.import`     | `importInventory`                  | Parse an inventory export for reconciliation   |

The last three are the file-based path (ADR 0002); everything above them needs an API.
`listing.push` deliberately **cannot** create — a `PushListingRequest` carries no title,
image or vendor, so a connector creating from one would be inventing them. That is what
`listing.create` is for, and its content is an input the operator supplies.

The read-only ones — `listing.tags`, `listing.metafields`, `listing.publications` — exist
so the core can offer the store's **own** vocabulary rather than deriving values. A tag
the hub invented puts a product in no collection: invisible in the shop, reported by
nothing.

Every method is optional. Declaring a capability without its method — or implementing a
method without declaring the capability — is rejected at startup by `validateConnector`,
because the core dispatches on capabilities and an undeclared method would silently never
run.

### Catalog sources are a different thing

There is no `catalog.search` capability. Product lookup is not a sales-channel concern — a
catalog source has no listings, no orders, and no place in the allocation loop — so it
lives behind the separate `CatalogSource` interface, with its own much smaller contract
suite (`runCatalogSourceContractTests`).

A package may export both when a platform genuinely does both. If TCGPlayer API access
were ever restored, its package would export a `Connector` for selling and a
`CatalogSource` for lookups, and neither would have to pretend to be the other.

The rule for a `CatalogSource`: **never fabricate a foreign id.** Coverage is never
complete — Scryfall omits `tcgplayer_id` on roughly a tenth of a modern Magic set and on
many older printings — and a blank id written to `CatalogExternalRef` is worse than an
absent one, because it will never match anything. Omit the key.

### File-based channels are first class

The last three capabilities exist because not every marketplace has a usable API.
TCGPlayer closed its developer programme (see [ADR 0002](adr/0002-tcgplayer-without-an-api.md)),
so its connector renders a CSV the operator uploads and ingests the sales export they get
back. A connector declaring only file capabilities is not a degraded connector; it is a
`manual` channel, and the core knows to present it that way and not to mistake its
staleness for drift.

## Rules the contract tests enforce

- **Verify webhook signatures.** `orders.webhook` requires `verifyWebhook`. You receive
  the byte-exact raw body — do not parse or re-serialize before verifying, or the HMAC
  will not match. An unverified endpoint accepts forged sales from anyone who learns the
  URL.
- **Idempotency keys must be deterministic.** Every event carries `externalEventId`, and
  the same input must always produce the same key. Webhooks get redelivered and operators
  re-upload the same export; a random key double-decrements stock. Hash the payload when
  the platform gives you no id.
- **Malformed input is reported, not thrown.** One bad row in a thousand-row export must
  not discard the other 999. Return `{ records, problems }`.
- **Money is integer cents.** Never a float, never a formatted string.
- **Secrets stay out of `configSchema`.** Declare them in `secretFields`; the core stores
  them encrypted and hands them to you in `Ctx.secrets` at call time only. Never persist
  or log them.
- **Do not invent reconciliation state.** Omit listings you cannot find rather than
  reporting quantity 0 for them — a fabricated zero reads as drift and raises a spurious
  alert.

## Rate limiting and retries

Declare `rateLimit` and let the core's queue enforce it. Retries, backoff and per-channel
limits all live in the core (§5) so they behave identically for every connector. Do not
implement your own.

## Running the contract suite

```ts
import { runConnectorContractTests } from '@hub/connector-sdk/testing';

runConnectorContractTests({
  connector: makeMyConnector(mockPlatformClient),
  makeCtx: () => ({ channelInstanceId: 'test', config: {}, secrets: {}, logger }),
  validWebhook: { headers, rawBody }, // if you do webhooks
  validOrderExport: { filename, content }, // if you do file import
});
```

Run it against a **mock** platform, never a live seller account. That is what allowed the
TCGPlayer connector to be built and verified while its API application sat unapproved, and
it is why running the suite costs nothing and risks nothing.

Only your declared capabilities are exercised. A connector that supports two things well is
not penalised against one that supports six badly.
