import type { Ctx } from '@hub/connector-sdk';
import { ShopifyError, ShopifyTransientError, type FetchLike } from './errors';

/**
 * Access tokens via the OAuth **client credentials** grant.
 *
 * Shopify retired legacy custom apps on 1 January 2026. There is no longer a
 * permanent Admin API token to paste into a settings form: an app built in the
 * Dev Dashboard for a store you own holds a client id and secret, and exchanges
 * them for a token that lives 24 hours (`expires_in` is always 86399).
 *
 * That turns authentication from "a stored string" into a small piece of state
 * with a clock attached, which is why it lives here rather than inline in the
 * client:
 *
 * - **Cached per channel**, not globally. Two Shopify stores are two
 *   installations with two client secrets and two tokens; a shared cache would
 *   let one store's token be sent to the other.
 * - **Refreshed early**, not on expiry. A token that lapses mid-flight fails a
 *   push that had nothing wrong with it, so it is replaced while there is still
 *   a margin left.
 * - **In-flight requests are shared.** A burst of pushes on a cold cache would
 *   otherwise each mint their own token, and Shopify rate-limits this endpoint
 *   like any other.
 *
 * The tokens are held in memory only. They are derived data with a one-day life
 * — persisting them would mean encrypting and rotating a second secret to save
 * one HTTP request a day.
 */

interface CachedToken {
  token: string;
  /** Epoch ms. Already reduced by the safety margin below. */
  usableUntil: number;
}

/**
 * Refresh this far before Shopify would expire the token.
 *
 * Five minutes covers a slow queue drain and clock skew between us and Shopify,
 * and costs one extra token request per day.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface TokenSource {
  /** A valid token for this channel, minted or reused. */
  get(ctx: Ctx, shopDomain: string): Promise<string>;
  /** Discard the cached token, so the next call mints a fresh one. */
  invalidate(channelInstanceId: string): void;
}

export function createTokenSource(doFetch: FetchLike, now: () => number = Date.now): TokenSource {
  const cache = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<string>>();

  return {
    async get(ctx: Ctx, shopDomain: string): Promise<string> {
      const key = ctx.channelInstanceId;

      const cached = cache.get(key);
      if (cached && cached.usableUntil > now()) return cached.token;

      // Collapse a burst onto one request. Without this, ten queued pushes on a
      // cold cache make ten token calls and Shopify throttles the lot.
      const existing = inFlight.get(key);
      if (existing) return existing;

      const pending = mint(doFetch, ctx, shopDomain)
        .then(({ token, expiresInSeconds }) => {
          cache.set(key, {
            token,
            usableUntil: now() + Math.max(0, expiresInSeconds * 1000 - REFRESH_MARGIN_MS),
          });
          return token;
        })
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, pending);
      return pending;
    },

    invalidate(channelInstanceId: string): void {
      cache.delete(channelInstanceId);
    },
  };
}

/**
 * Exchange the client credentials for a token.
 *
 * Form-encoded, not JSON: Shopify's token endpoint documents
 * `application/x-www-form-urlencoded` and answers JSON.
 */
async function mint(
  doFetch: FetchLike,
  ctx: Ctx,
  shopDomain: string,
): Promise<{ token: string; expiresInSeconds: number }> {
  const clientId = String(ctx.config.clientId ?? '').trim();
  const clientSecret = ctx.secrets.clientSecret;

  if (!clientId) {
    throw new ShopifyError(
      'Channel is not configured: clientId is missing. Find it on your app’s Settings ' +
        'page in the Shopify Dev Dashboard.',
    );
  }
  if (!clientSecret) {
    throw new ShopifyError(
      'Channel is not connected: no Shopify client secret stored. Legacy custom-app access ' +
        'tokens were retired on 1 January 2026; this connector authenticates with the client ' +
        'id and secret from your Dev Dashboard app instead.',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  let response: Response;
  try {
    response = await doFetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: ctx.signal,
    });
  } catch (error) {
    // A network failure here is no different from one on a query: worth
    // retrying, and the queue already knows how.
    throw new ShopifyTransientError(
      `Could not reach Shopify to authenticate: ${(error as Error).message}`,
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw new ShopifyTransientError(
      `Shopify responded ${response.status} while authenticating; retryable.`,
      response.status,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  };

  if (!response.ok) {
    // Deliberately not retryable. Bad credentials, an uninstalled app or a
    // shop domain that is not ours all fail identically forever, and burning
    // the queue's retry budget on them delays everything behind.
    throw new ShopifyError(
      `Shopify refused these credentials (HTTP ${response.status}): ` +
        `${String(payload.error_description ?? payload.error ?? 'no reason given')}. ` +
        `Check the client id and secret, and that the app is installed on ${shopDomain}.`,
    );
  }

  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw new ShopifyError('Shopify returned no access token.');
  }

  // Documented as always 86399, but read rather than assumed — a hard-coded day
  // would outlive the token the moment that changes.
  const expiresInSeconds =
    typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600;

  ctx.logger.debug(`Minted a Shopify access token, valid for ${expiresInSeconds}s`);

  return { token: payload.access_token, expiresInSeconds };
}
