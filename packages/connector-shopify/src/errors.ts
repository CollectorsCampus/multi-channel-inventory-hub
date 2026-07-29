/**
 * Shared failure types and the network seam.
 *
 * Extracted from client.ts so the token source can raise the same errors the
 * query path does without the two importing each other — authentication is a
 * request like any other, and the queue must treat a throttled token mint
 * exactly as it treats a throttled query.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A failure Shopify reported.
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
