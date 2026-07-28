import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * The read-only SQL console (§7).
 *
 * Off by default, so the status query is what decides whether the nav even
 * shows a link. It is readable by any signed-in user; running a statement is
 * admin-only and enforced on the server, which this client only reflects.
 */

export interface QueryConsoleStatus {
  enabled: boolean;
  /** Enabled but unusable — e.g. the deployment is not on PostgreSQL. */
  available: boolean;
  reason?: string;
  maxRows: number;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when more rows matched than were returned. */
  truncated: boolean;
  durationMs: number;
}

export function useQueryConsoleStatus() {
  return useQuery({
    queryKey: ['query-console', 'status'],
    queryFn: () => apiFetch<QueryConsoleStatus>('/query-console/status'),
    // A deployment-level flag; it cannot change without a restart.
    staleTime: Infinity,
  });
}

export function useRunQuery() {
  return useMutation({
    mutationFn: (body: { sql: string; maxRows?: number }) =>
      apiFetch<QueryResult>('/query-console/query', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // Deliberately no cache invalidation: a read changes nothing, and refetching
    // the app's queries after one would imply otherwise.
  });
}

/**
 * Render one cell.
 *
 * The server has already flattened bigints, dates and buffers to strings; what
 * can still arrive is a JSON column or an array, which is shown as compact JSON
 * rather than `[object Object]`.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
