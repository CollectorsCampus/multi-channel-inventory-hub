# Connector authoring guide

> **Phase 0 placeholder.** The `Connector` interface and the shared contract test suite are
> Phase 2 deliverables. This file will become the spec for community connector authors
> (eBay, Square, Cardmarket, …), with the contract tests doubling as its executable form.

## The one rule

**Connectors are dumb pipes. The core owns all quantity math.**

A connector translates between the core's canonical operations and one platform's API. It
never decides how many units to list, never reads the ledger, and never resolves a conflict.
If you find yourself computing a quantity inside a connector, the abstraction has been
breached — raise it as an issue rather than working around it.

## What a connector will implement

See `TECHNICAL_DESIGN.md` §5 for the current interface sketch. In outline:

| Area      | Methods                                                  |
| --------- | -------------------------------------------------------- |
| Catalog   | `searchCatalog?`                                         |
| Outbound  | `pushListing`, `updateQuantity`, `updatePrice`, `delist` |
| Inbound   | `verifyWebhook?`, `parseWebhook?`, `pollChanges?`        |
| Reconcile | `fetchLiveState`                                         |

Three things are declared rather than assumed:

- **`capabilities`** — the core degrades gracefully around what you do not support. A
  connector without `orders.webhook` is automatically scheduled for `pollChanges` instead.
- **`configSchema`** — JSON Schema. The settings UI for your connector is generated from
  this, so community connectors get a real config form without touching core code.
- **Rate limits** — declared, then enforced by the core's queue layer. Do not implement
  your own throttling or retry logic; it belongs in one place.

## Credentials

Credentials never appear in `config`. The core holds an encrypted credential store
(AES-256-GCM, master key from env/KMS) and passes decrypted secrets to your connector only
inside `Ctx`, at call time. Never persist a secret yourself, and never log one.

## Webhook ingress

Ingress does no work inline: verify the signature, persist the raw event, enqueue, return 200. `verifyWebhook` receives the byte-exact raw body — do not parse or re-serialize before
verifying, or HMAC comparison will fail for reasons that are painful to debug.
