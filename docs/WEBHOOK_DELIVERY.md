# Webhook delivery methods — researched 2026-07-30

Three Shopify documents were read to see whether they offer anything this project should
adopt. Verdicts first, because two of the three are cheap to dismiss and the third is a
real option that has **not** been taken.

| Document                | Verdict                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| App automation tokens   | **Not applicable.** Not an Admin API credential. Nothing here uses the CLI. |
| EventBridge delivery    | Viable, same shape as Pub/Sub, but adds an AWS dependency. Not recommended. |
| Google Pub/Sub delivery | **The one worth a decision** — it removes the public HTTPS endpoint.        |

---

## 1. App automation tokens — not what the name suggests

<https://shopify.dev/docs/apps/build/dev-dashboard/app-automation-tokens>

**These authenticate the Shopify CLI in CI/CD. They are not Admin API access tokens.** A
token is "scoped to the specific app where it was created" and "can only be used to deploy
the app it belongs to" — it deploys app configuration and extensions, nothing more. It
cannot read a product or write an inventory level.

The reason to check was the 24-hour lifetime of the client-credentials token
(`connector-shopify/src/tokens.ts`), and whether a 1/3/6-month automation token could
replace that machinery. **It cannot.** Different credential, different purpose. The token
cache, the five-minute early refresh, the single-flight collapse and the 401-retry all stay
exactly as they are.

There is also no second use for it here: this repository has no `shopify.app.toml`, no
extensions, and never invokes the Shopify CLI. The app is configured by hand in the Dev
Dashboard and the connector talks to the Admin API directly.

**Settled. Do not re-investigate** unless the project starts shipping a Shopify app with
extensions, which is a different product from a self-hosted hub.

## 2 and 3. Cloud event buses — Pub/Sub and EventBridge

<https://shopify.dev/docs/apps/build/webhooks/get-started?deliveryMethod=pubSub&framework=remix>
<https://shopify.dev/docs/apps/build/webhooks/get-started?deliveryMethod=eventBridge&framework=remix>

Both are the same idea: Shopify delivers to a cloud message bus instead of POSTing to a URL
of yours, and your application consumes from the bus.

Three facts that matter, all from Shopify's own documentation:

- **No new mutation is needed.** Both use `webhookSubscriptionCreate`, the same mutation
  the live-store proving run already used. Only the `uri` differs —
  `pubsub://{project-id}:{topic-id}`, or the partner event source ARN for EventBridge.
- **HMAC verification does not apply.** Verbatim: "HMAC verification applies to HTTPS
  deliveries only. Google Cloud Pub/Sub and Amazon EventBridge deliveries don't require
  it." ([verify-deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries))
- **Shopify recommends Pub/Sub** as its cloud-based option, with EventBridge as the
  equivalent alternative.

### What this would actually buy — and it is not the HMAC

The documentation sells these on removing HMAC complexity. **For this project that benefit
is close to zero**, and saying otherwise would misread our own history. The HMAC path is
already built, already proven against two genuine live deliveries, and pinned
arithmetically: recomputing `base64(HMAC-SHA256(stored_body, clientSecret))` reproduces the
header Shopify sent over a 5170-byte body. `bootstrap.ts` registers the raw-body parser and
`boot.spec.ts` guards it. That complexity is paid for, tested, and behind us.

**The real prize is that a pull-based consumer needs no public HTTPS endpoint.** Today the
ingress is a public `POST /webhooks/:channelInstanceId` where, as the controller says in as
many words, "the HMAC _is_ the authentication". That requires a self-hoster to expose a
routable HTTPS endpoint with a valid certificate. Proving webhooks at all required a
`cloudflared` quick tunnel. For self-hosted inventory software — often a box behind NAT in
the back of a shop — that is the single hardest deployment prerequisite in the product.

With Pub/Sub the hub makes an **outbound** connection and pulls. No inbound port, no
certificate, no tunnel, no dynamic DNS.

### The architecture already supports this

Worth knowing before anyone estimates it: **the ingress is not the pipeline.** A second,
non-HTTP producer of `WebhookEvent` rows already exists — `ChannelFilesService` writes one
with topic `file:orders` and no HTTP anywhere, and the inbound worker processes it
identically to a Shopify delivery. That is the same rule CLAUDE.md records as "uploaded
files ride the webhook path".

A Pub/Sub consumer would be a **third producer of the same rows**. Everything downstream —
dedupe on the body hash, `InboundQueue`, per-sale idempotency, allocation lookup, oversell
alerting — is reached unchanged. The work is a subscriber loop and credential handling, not
a new pipeline.

### Why it has not been adopted

**It trades one deployment prerequisite for a harder one.** A public HTTPS endpoint is
awkward; a Google Cloud project with a Pub/Sub topic, a service account, and a billing
relationship is a larger ask, and it puts a third party in the path of every sale event.
This is AGPL software whose entire premise is that you run it yourself. Requiring GCP or
AWS to receive an order would undercut that for the majority who can manage a reverse proxy
or a tunnel.

It also moves authentication from something self-contained — an HMAC over a body, verified
with a secret we already hold — to cloud IAM, which is a credential type
`CredentialStore` has never handled and which does not fit the
`AES-256-GCM(ref-bound)` shape the schema assumes.

### The shape it should take if it is ever built

Not a replacement. **An alternative ingress, chosen per channel**, with HTTPS remaining the
default:

- A new capability is probably wrong. Delivery method is a property of _this deployment's_
  subscription, not of what the connector can do — Shopify supports all three regardless.
  It belongs in channel config, beside `shopDomain`.
- The consumer must dedupe on the same body hash the controller uses. Pub/Sub is
  at-least-once and gives no ordering guarantee, so redeliveries are routine rather than
  exceptional — which the existing `externalEventId` unique constraint already handles.
- `verifyWebhook` must not be bypassed for HTTPS deliveries just because another path does
  not need it. The SDK's rule — a connector declaring `orders.webhook` must implement
  `verifyWebhook` — stays, or the HTTPS endpoint silently becomes unauthenticated.
- Pub/Sub over EventBridge, on Shopify's own recommendation and because the ARN dance is
  more setup for no benefit here.

**This is a decision, not a defect.** Nothing is broken today. It is worth revisiting the
first time a real self-hoster cannot expose an endpoint.
