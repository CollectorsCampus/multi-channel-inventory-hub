import type { Ctx } from '@hub/connector-sdk';
import { ShopifyError, ShopifyTransientError, type FetchLike } from './errors';
import { createTokenSource, type TokenSource } from './tokens';

/**
 * Thin Admin GraphQL client.
 *
 * Separated from the connector so the connector's tests drive a mock of *this*
 * rather than mocking `fetch` and re-encoding Shopify's wire format in every
 * assertion. The contract suite runs against a mock platform, never a live
 * store (§10).
 *
 * Authentication is not a stored string. Shopify retired legacy custom apps on
 * 1 January 2026, and a Dev Dashboard app for a store you own exchanges its
 * client id and secret for a 24-hour token — see tokens.ts. The client asks for
 * one before every request and lets the token source decide whether that means
 * a network call.
 */

/**
 * Pinned deliberately: Shopify's GraphQL schema changes between versions, and
 * they support roughly a year of them. Bumping this means re-checking every
 * document in shopify.ts, not just editing the string.
 */
export const SHOPIFY_API_VERSION = '2026-07';

export { ShopifyError, ShopifyTransientError, type FetchLike } from './errors';

export interface ShopifyClient {
  request<T>(ctx: Ctx, query: string, variables?: Record<string, unknown>): Promise<T>;
}

export function createShopifyClient(fetchImpl?: FetchLike, tokens?: TokenSource): ShopifyClient {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const tokenSource = tokens ?? createTokenSource(doFetch);

  return {
    async request<T>(ctx: Ctx, query: string, variables?: Record<string, unknown>): Promise<T> {
      const shopDomain = String(ctx.config.shopDomain ?? '').trim();
      if (!shopDomain) {
        throw new ShopifyError('Channel is not configured: shopDomain is missing.');
      }

      const send = async (token: string): Promise<Response> =>
        doFetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
          signal: ctx.signal,
        });

      let response = await send(await tokenSource.get(ctx, shopDomain));

      /**
       * One retry on 401, with a freshly minted token.
       *
       * A token can be revoked before it expires — the app is reinstalled, its
       * scopes change, someone rotates the secret — and the cached copy then
       * looks valid to us and is not. Retrying once turns that into a blip
       * rather than a channel that stays broken until the cache happens to
       * lapse. Only once: if the new token is also refused, the credentials are
       * wrong and repeating cannot help.
       */
      if (response.status === 401) {
        ctx.logger.warn('Shopify rejected the access token; minting a new one and retrying.');
        tokenSource.invalidate(ctx.channelInstanceId);
        response = await send(await tokenSource.get(ctx, shopDomain));
      }

      // 429 is throttling, 5xx is Shopify being unwell. Both are worth another
      // attempt later; everything else is our fault and will fail identically
      // on retry.
      if (response.status === 429 || response.status >= 500) {
        throw new ShopifyTransientError(
          `Shopify responded ${response.status}; retryable.`,
          response.status,
        );
      }

      if (!response.ok) {
        throw new ShopifyError(`Shopify responded ${response.status}.`);
      }

      const payload = (await response.json()) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };

      if (payload.errors?.length) {
        // Shopify's own throttling arrives here with HTTP 200.
        const message = payload.errors.map((e) => e.message).join('; ');
        if (/throttled/i.test(message)) {
          throw new ShopifyTransientError(`Shopify throttled the request: ${message}`);
        }
        throw new ShopifyError(message, payload.errors);
      }

      if (!payload.data) throw new ShopifyError('Shopify returned no data.');
      return payload.data;
    },
  };
}

/**
 * Shopify reports business-level failures in `userErrors` alongside HTTP 200.
 * Every mutation must be checked, or a failed push looks like a success and the
 * ledger records a listing that does not exist.
 */
export function throwOnUserErrors(
  userErrors: Array<{ field?: string[] | null; message: string }> | undefined,
  operation: string,
): void {
  if (!userErrors?.length) return;
  const detail = userErrors
    .map((e) => (e.field?.length ? `${e.field.join('.')}: ${e.message}` : e.message))
    .join('; ');
  throw new ShopifyError(`${operation} failed: ${detail}`, userErrors);
}
