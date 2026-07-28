import type { Ctx } from '@hub/connector-sdk';

/**
 * Thin Admin GraphQL client.
 *
 * Separated from the connector so the connector's tests drive a mock of *this*
 * rather than mocking `fetch` and re-encoding Shopify's wire format in every
 * assertion. The contract suite runs against a mock platform, never a live
 * store (§10).
 */

/** Pinned deliberately: Shopify's GraphQL schema changes between versions. */
export const SHOPIFY_API_VERSION = '2025-01';

export interface ShopifyClient {
  request<T>(ctx: Ctx, query: string, variables?: Record<string, unknown>): Promise<T>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A GraphQL error Shopify reported.
 *
 * Shopify answers 200 for business-level failures and reports them in
 * `userErrors`, so treating HTTP status as success would silently swallow
 * "variant not found" or "inventory not stocked at location".
 */
export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

/** Retryable: Shopify throttled us or had an outage. The queue will back off. */
export class ShopifyTransientError extends ShopifyError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShopifyTransientError';
  }
}

export function createShopifyClient(fetchImpl?: FetchLike): ShopifyClient {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    async request<T>(ctx: Ctx, query: string, variables?: Record<string, unknown>): Promise<T> {
      const shopDomain = String(ctx.config.shopDomain ?? '').trim();
      if (!shopDomain) {
        throw new ShopifyError('Channel is not configured: shopDomain is missing.');
      }

      const accessToken = ctx.secrets.accessToken;
      if (!accessToken) {
        throw new ShopifyError('Channel is not connected: no Shopify access token stored.');
      }

      const response = await doFetch(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: ctx.signal,
        },
      );

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
