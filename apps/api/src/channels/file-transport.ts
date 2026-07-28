import type { ImportProblem } from '@hub/connector-sdk';

/**
 * The vocabulary shared between the upload endpoint and the inbound worker
 * (ADR 0002).
 *
 * Kept apart from the service that implements it so the worker can recognise an
 * uploaded file without importing the channels service — the two sit on
 * opposite sides of the queue, the same split QueueModule and SyncModule
 * already observe.
 */

export type ImportKind = 'orders' | 'inventory';

export const IMPORT_KINDS: readonly ImportKind[] = ['orders', 'inventory'];

/**
 * Marks a `WebhookEvent` row as an operator upload rather than a platform
 * delivery.
 *
 * Uploads reuse that table deliberately. A file is a raw inbound payload with a
 * dedupe key, a processing status and an error — every column already means
 * what it needs to mean — and giving files their own table would have
 * duplicated the queue plumbing to go with it.
 */
export const FILE_TOPIC_PREFIX = 'file:';

export function isFileTopic(topic: string | null | undefined): boolean {
  return topic?.startsWith(FILE_TOPIC_PREFIX) ?? false;
}

export function fileTopicKind(topic: string | null | undefined): string {
  return topic?.slice(FILE_TOPIC_PREFIX.length) ?? '';
}

export interface ImportSummary {
  kind: ImportKind;
  filename: string;
  /** Rows the connector could turn into something usable. */
  recordCount: number;
  problems: ImportProblem[];
  /** True when this exact file has been uploaded before. */
  duplicate: boolean;
  /** Orders only: the sales were queued, and the ledger moves asynchronously. */
  queued: boolean;
  /**
   * Inventory only: listings whose platform quantity differs from what we
   * believe the channel is advertising.
   *
   * Informational. Reconciliation (Phase 5) is what turns a difference into a
   * decision; this is only enough to tell an operator whether a round trip
   * landed.
   */
  differences?: Array<{
    externalListingId: string;
    platformQuantity: number;
    believedQuantity: number;
  }>;
  /** Inventory only: rows in the file that map to no allocation we hold. */
  unmappedCount?: number;
}
