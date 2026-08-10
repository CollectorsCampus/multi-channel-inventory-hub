import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from './client';
import type { JsonSchema } from '../components/SchemaForm';
import type { ListingMetafield } from './listings';

export interface ConnectorSummary {
  key: string;
  displayName: string;
  description?: string;
  capabilities: string[];
  syncMode: 'continuous' | 'polled' | 'manual' | 'outbound-only';
  configSchema: JsonSchema;
  secretFields: string[];
  /** Subset of secretFields a channel can work without. */
  optionalSecretFields: string[];
}

/**
 * What a channel puts on the listings it creates.
 *
 * Every field is optional, and an empty array is a real answer rather than an
 * absent one — `tags: []` means "no tags" and is what lets a run say so. The
 * server depends on that distinction, so nothing here may collapse it.
 */
/**
 * One "cards like this get this tag" rule.
 *
 * The tag is the operator's, chosen from the store's own vocabulary; the rule
 * only says which cards it applies to, from facts the ledger already holds.
 */
export type TagRuleMatch = 'game' | 'set' | 'name-contains' | 'kind';

/**
 * What sort of thing an item is. `kind` rules take one of these as their value.
 *
 * Three rather than two: `other` is the `NA` condition — a playmat, a binder, a
 * Funko Pop — and calling one of those "sealed" would file it with the booster
 * boxes.
 */
export type ItemKind = 'single' | 'sealed' | 'other';

export interface TagRule {
  match: TagRuleMatch;
  value: string;
  tag: string;
}

/** Like a TagRule, but sets the product's vendor. First match wins. */
export interface VendorRule {
  match: TagRuleMatch;
  value: string;
  vendor: string;
}

/** Like a TagRule, but sets a custom field. `custom.game` by game, `custom.set` by set. */
export interface MetafieldRule {
  match: TagRuleMatch;
  value: string;
  metafield: ListingMetafield;
}

export interface ChannelListingDefaults {
  /** Applied to every created product whatever it is. Usually empty. */
  tags?: string[];
  /** Applied when they match the card. This is how a mixed batch is tagged correctly. */
  tagRules?: TagRule[];
  metafields?: ListingMetafield[];
  /** Custom fields applied when a rule matches — the per-card counterpart of metafields. */
  metafieldRules?: MetafieldRule[];
  category?: string;
  vendor?: string;
  /** Vendor applied when a rule matches, falling back to the flat vendor. First match wins. */
  vendorRules?: VendorRule[];
  /** Sales channels (publication ids) every created product is published to. */
  publications?: string[];
}

/** A sales channel a product can be published to, from GET .../listings/publications. */
export interface ListingPublication {
  id: string;
  name: string;
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
  lastReconciledAt: string | null;
  reconcileAutoCorrect: boolean;
  /** Opt-in: list stock here as it is taken in. Server refuses it without defaults. */
  autoListNewStock: boolean;
  /** Opt-in: draft a single's product when its pushed quantity reaches zero. */
  draftAtSellout: boolean;
  /** What a listing created here carries. Applied verbatim; never derived. */
  listingDefaults: ChannelListingDefaults;
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
      reconcileAutoCorrect?: boolean;
      autoListNewStock?: boolean;
      draftAtSellout?: boolean;
      /** Replaced wholesale, not merged — sending `{ tags: [] }` clears them. */
      listingDefaults?: ChannelListingDefaults;
    }) => apiFetch<Channel>(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  );
}

export function useDeleteChannel() {
  return useChannelMutation((id: string) =>
    apiFetch<void>(`/channels/${id}`, { method: 'DELETE' }),
  );
}

// ---------------------------------------------------------------------------
// Reconciliation (§6)
// ---------------------------------------------------------------------------

export type DriftKind = 'quantity' | 'price' | 'inactive' | 'missing';

export interface Drift {
  allocationId: string;
  /** The item to correct when the channel is right and the ledger is not. */
  inventoryItemId?: string;
  externalListingId: string;
  kind: DriftKind;
  ours: number | null;
  theirs: number | null;
  detail: string;
  /** Product identity for display, so a finding names what a listing is. */
  name?: string;
  setName?: string;
  condition?: string;
}

export interface ReconcileOutcome {
  channelInstanceId: string;
  channelName: string;
  summary: string;
  corrected: number;
  ranAt: string;
  report: {
    checked: number;
    drifts: Drift[];
    pending: Array<{
      allocationId: string;
      externalListingId: string;
      listedQuantity: number;
      desiredListedQuantity: number;
      name?: string;
      setName?: string;
      condition?: string;
    }>;
    unmanaged: string[];
  };
}

export function useReconcileChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<ReconcileOutcome>(`/channels/${channelId}/reconcile`, { method: 'POST' }),
    // The run stamps lastReconciledAt and may raise or clear an alert.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.list }),
  });
}

/** Plain-language name for a finding, since "kind" is our word, not an operator's. */
export function describeDriftKind(kind: DriftKind): string {
  switch (kind) {
    case 'quantity':
      return 'Quantity differs';
    case 'price':
      return 'Price differs';
    case 'inactive':
      return 'Inactive on the channel';
    case 'missing':
      return 'Not found on the channel';
  }
}

// ---------------------------------------------------------------------------
// File transport (ADR 0002)
// ---------------------------------------------------------------------------

export type ImportKind = 'orders' | 'inventory';

export interface ImportProblem {
  line?: number;
  message: string;
}

export interface ImportSummary {
  kind: ImportKind;
  filename: string;
  recordCount: number;
  problems: ImportProblem[];
  duplicate: boolean;
  queued: boolean;
  differences?: Array<{
    externalListingId: string;
    platformQuantity: number;
    believedQuantity: number;
  }>;
  unmappedCount?: number;
}

export interface ExportResult {
  filename: string;
  /** Allocations on this channel, mapped or not. */
  listings: number;
  /** Of those, the ones with no platform id, which the file cannot cover. */
  unmapped: number;
}

/**
 * Download a channel's export and hand it to the browser.
 *
 * Fetched rather than linked, for two reasons: a plain `<a href>` cannot send
 * the session cookie policy this client uses, and the counts the operator needs
 * — how many listings the file covers, and how many it could not — come back in
 * response headers a link never exposes.
 */
export async function downloadChannelExport(channelId: string): Promise<ExportResult> {
  const response = await fetch(`/api/channels/${channelId}/export`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const message = (payload as { message?: string } | undefined)?.message;
    throw new ApiError(response.status, message ?? `Export failed (${response.status})`, payload);
  }

  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get('content-disposition')) ?? 'export.csv';

  // Synthesised anchor rather than navigation: navigating away would tear down
  // the page while the operator is mid-task.
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }

  return {
    filename,
    listings: Number(response.headers.get('x-listing-count') ?? 0),
    unmapped: Number(response.headers.get('x-unmapped-count') ?? 0),
  };
}

/**
 * Upload a file exported from the platform.
 *
 * The body is the raw file as `text/csv`. `kind` is stated rather than sniffed
 * because the two imports have very different consequences — one records sales
 * and moves stock, the other only reports — and the server verifies the file
 * really is the one claimed.
 */
export function uploadChannelFile(
  channelId: string,
  kind: ImportKind,
  file: File,
): Promise<ImportSummary> {
  const query = new URLSearchParams({ kind, filename: file.name });
  return apiFetch<ImportSummary>(`/channels/${channelId}/import?${query}`, {
    method: 'POST',
    // Set explicitly: an OS may report a .csv as application/vnd.ms-excel, and
    // the server only parses text/csv.
    headers: { 'Content-Type': 'text/csv' },
    body: file,
  });
}

export function useExportChannel() {
  return useMutation({ mutationFn: (channelId: string) => downloadChannelExport(channelId) });
}

export function useImportChannelFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kind, file }: { id: string; kind: ImportKind; file: File }) =>
      uploadChannelFile(id, kind, file),
    // An inventory import stamps lastReconciledAt, and an orders import will
    // move allocation counts once its jobs run.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: channelKeys.list }),
  });
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1];
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
