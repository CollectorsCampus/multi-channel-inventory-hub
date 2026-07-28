import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface SyncEvent {
  id: string;
  ts: string;
  direction: 'inbound' | 'outbound' | 'reconcile';
  outcome: 'pending' | 'ok' | 'error' | 'conflict';
  operation: string | null;
  entityType: string;
  entityId: string | null;
  detail: string | null;
  durationMs: number | null;
  channelInstanceId: string | null;
  channelName: string | null;
  payload: unknown;
}

export interface Alert {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  channelInstanceId: string | null;
  channelName: string | null;
  inventoryItemId: string | null;
  context: unknown;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function toQuery(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useSyncEvents(filters: {
  direction?: string;
  outcome?: string;
  entityIds?: string[];
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  const { entityIds, enabled = true, ...rest } = filters;
  const query = toQuery({ ...rest, entityIds: entityIds?.join(',') });

  return useQuery({
    queryKey: ['sync', 'events', query],
    queryFn: () => apiFetch<Page<SyncEvent>>(`/sync/events${query}`),
    enabled,
    placeholderData: (previous) => previous,
    // A long-lived operations screen should show work as it happens.
    refetchInterval: 15_000,
  });
}

export function useAlerts(filters: { status?: string; kind?: string; page?: number }) {
  const query = toQuery(filters);
  return useQuery({
    queryKey: ['sync', 'alerts', query],
    queryFn: () => apiFetch<Page<Alert>>(`/sync/alerts${query}`),
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
  });
}

/** Drives the nav badge, so an operator sees a new alert without opening the page. */
export function useOpenAlertCount() {
  return useQuery({
    queryKey: ['sync', 'alerts', 'count'],
    queryFn: () => apiFetch<{ open: number }>('/sync/alerts/count'),
    refetchInterval: 30_000,
  });
}

export function useAlertAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'acknowledge' | 'resolve' | 'reopen' }) =>
      apiFetch<Alert>(`/sync/alerts/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sync'] }),
  });
}
