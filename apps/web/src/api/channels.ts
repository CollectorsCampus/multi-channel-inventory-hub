import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { JsonSchema } from '../components/SchemaForm';

export interface ConnectorSummary {
  key: string;
  displayName: string;
  description?: string;
  capabilities: string[];
  syncMode: 'continuous' | 'polled' | 'manual' | 'outbound-only';
  configSchema: JsonSchema;
  secretFields: string[];
}

export interface Channel {
  id: string;
  connectorKey: string;
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Which secret fields have a stored value. Never the values themselves. */
  secretsSet: string[];
  secretFieldsRequired: string[];
  syncMode: ConnectorSummary['syncMode'];
  capabilities: string[];
  healthStatus: string;
  healthDetail: string | null;
  webhookPath: string | null;
  allocationCount: number;
  createdAt: string;
}

const channelKeys = {
  list: ['channels'] as const,
  connectors: ['channels', 'connectors'] as const,
};

export function useConnectors() {
  return useQuery({
    queryKey: channelKeys.connectors,
    queryFn: () => apiFetch<ConnectorSummary[]>('/channels/connectors'),
    staleTime: 5 * 60_000,
  });
}

export function useChannels() {
  return useQuery({
    queryKey: channelKeys.list,
    queryFn: () => apiFetch<Channel[]>('/channels'),
  });
}

function useChannelMutation<TArgs>(request: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.list }),
  });
}

export function useCreateChannel() {
  return useChannelMutation(
    (body: {
      connectorKey: string;
      displayName: string;
      config: Record<string, unknown>;
      secrets?: Record<string, string>;
    }) => apiFetch<Channel>('/channels', { method: 'POST', body: JSON.stringify(body) }),
  );
}

export function useUpdateChannel() {
  return useChannelMutation(
    ({
      id,
      ...body
    }: {
      id: string;
      displayName?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      secrets?: Record<string, string>;
    }) => apiFetch<Channel>(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  );
}

export function useDeleteChannel() {
  return useChannelMutation((id: string) =>
    apiFetch<void>(`/channels/${id}`, { method: 'DELETE' }),
  );
}

/** Plain-language description of how current a channel's data can be. */
export function describeSyncMode(mode: ConnectorSummary['syncMode']): string {
  switch (mode) {
    case 'continuous':
      return 'Live — the platform notifies us of sales';
    case 'polled':
      return 'Polled — checked on a schedule';
    case 'manual':
      return 'Manual — as current as your last file upload';
    case 'outbound-only':
      return 'Outbound only — we push, but hear nothing back';
  }
}
