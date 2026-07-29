import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The one-time values that bind a login to the browser that started it.
 *
 * Pure functions over crypto primitives, kept apart from the service so each
 * can be tested for the property it exists to provide rather than through an
 * HTTP round trip.
 *
 * Three separate values, doing three separate jobs — a common mistake is to
 * reuse one for all of them, which quietly removes two of the protections:
 *
 * - **state** proves the callback belongs to a flow *this browser* started, and
 *   is what stops an attacker feeding their own authorization code to a
 *   logged-in victim (login CSRF).
 * - **nonce** is carried inside the ID token and proves the token was minted
 *   for this login rather than replayed from another one.
 * - **PKCE verifier** proves the party redeeming the code is the party that
 *   requested it, so an intercepted code is useless on its own.
 */

/** 32 bytes of randomness, base64url — comfortably past the spec's minimum. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * `plain` is deliberately not offered. It is still in the specification, and it
 * provides no protection whatsoever against an attacker who can see the
 * authorization request — which is the attack PKCE exists to stop.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    method: 'S256',
  };
}

/**
 * Compare two one-time values without leaking their contents through timing.
 *
 * `state` and `nonce` are secrets for the length of one login, and a plain
 * `===` on a secret is the kind of thing that is only obviously wrong in
 * hindsight.
 */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would itself be a signal;
  // comparing a digest of each keeps the comparison fixed-length.
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();

  return timingSafeEqual(leftDigest, rightDigest);
}
