# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/CollectorsCampus/multi-channel-inventory-hub/security/advisories/new).
That opens a private thread visible only to the maintainers, and it is the preferred route
because it needs no email address and keeps the report confidential until there is a fix.

You should get an acknowledgement within a few days. This is a small project, so please be
patient — and if you hear nothing after two weeks, feel free to nudge by opening a public
issue that says only that you are waiting on a security report, with no details.

## What is in scope

This is self-hosted software that holds live marketplace credentials and moves real stock,
so the things most worth reporting are:

- **Credential exposure.** Channel credentials are AES-256-GCM encrypted with the credential
  `ref` bound in as additional authenticated data. Anything that decrypts them without the
  key, moves ciphertext between channels, or leaks them into logs, API responses or the UI.
- **Authentication and session handling.** Session tokens are stored as SHA-256 hashes and
  API keys as argon2id. Session fixation, token leakage, CSRF, or a way to act as another
  user or escalate past the `viewer`/`editor`/`admin` boundaries.
- **The OIDC flow.** ID token verification goes through `jose` with an explicit asymmetric
  algorithm allow-list, a checked issuer and audience, and PKCE. Signature-verification
  bypasses, token confusion, or an open redirect via `returnTo`.
- **Webhook ingress.** `/api/webhooks/:id` is unauthenticated by necessity — the HMAC _is_
  the authentication. A way to get an unsigned or wrongly-signed delivery accepted would let
  anyone who learns the URL forge sales and move someone's stock.
- **The query console.** Off by default and admin-only, but a way to write through it, to
  reach it without admin, or to escape the `READ ONLY` transaction is in scope.
- **Ledger integrity.** Anything that lets a request break the invariant
  `quantityOnHand ≥ Σ(fixed) + reserveQuantity ≥ 0`, or write quantities outside
  `InventoryService`.

## What is not in scope

- **Findings from a default or misconfigured deployment** — running with a weak
  `SESSION_SECRET`, exposing Postgres or Redis to the internet, or pointing
  `QUERY_CONSOLE_DATABASE_URL` at a read-write role. The application refuses the last one at
  boot; the others are deployment decisions.
- **The read-only SQL console being able to read business data.** That is what it is for. It
  is admin-only, and an admin can already read that data through the UI. The statement-shape
  check in `statement.ts` is documented as a courtesy, **not a security boundary** — the
  boundary is the `SELECT`-only role plus the `READ ONLY` transaction. Bypassing the regex
  alone is not a vulnerability; getting a write to actually commit is.
- Missing hardening headers or rate limits with no demonstrated impact, automated scanner
  output without a working proof, and denial of service through sheer request volume.

## Supported versions

While the project is `0.x`, only the latest release receives fixes. There are no backports.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Operator notes

Two things matter more than anything in the code for a self-hoster:

- **`CREDENTIAL_MASTER_KEY` is the key to every stored channel credential.** Back it up, keep
  it out of version control, and rotate marketplace secrets rather than reusing them if you
  suspect it has leaked.
- **Rotating a Shopify client secret takes up to an hour to affect webhook signing**, per
  Shopify's documentation, so deliveries in that window may still verify against the old
  secret. Plan a rotation accordingly rather than assuming it is instant.
