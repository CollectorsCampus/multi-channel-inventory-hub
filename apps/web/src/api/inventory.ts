import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type AllocationMode = 'fixed' | 'pooled';

export interface Allocation {
  id: string;
  channelInstanceId: string;
  mode: AllocationMode;
  quantityAllocated: number | null;
  maxQuantity: number | null;
  /** Derived from the current ledger — what the channel should be advertising. */
  desiredListedQuantity: number;
  /** Cached belief about what it is actually advertising. */
  listedQuantity: number;
  status: string;
  price: number | null;
  currency: string;
  externalListingId: string | null;
}

export interface Ledger {
  inventoryItemId: string;
  skuId: string;
  quantityOnHand: number;
  reserveQuantity: number;
  pool: number;
  version: number;
  allocations: Allocation[];
}

export type InventoryRow = Ledger & {
  name: string;
  game: string | null;
  setName: string | null;
  /** Catalogue art, where the source had any. Null for a hand-entered item. */
  imageUrl: string | null;
  condition: string;
  printing: string;
  language: string;
};

export interface InventoryPage {
  items: InventoryRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface LedgerIssue {
  code: string;
  message: string;
  allocationId?: string;
}

export interface LedgerPreview {
  pool: number;
  issues: LedgerIssue[];
  /**
   * Keyed by channelInstanceId, not allocation id — a proposed allocation may
   * not exist yet and so has no id of its own.
   */
  listed: Record<string, number>;
}

export interface InventoryFilters {
  search?: string;
  game?: string;
  condition?: string;
  channelInstanceId?: string;
  /** Items whose catalog item has no game — non-TCG goods, hand-entered rows. */
  noGame?: boolean;
  /** Items on no channel at all. */
  unlisted?: boolean;
  /** Only items physically held — quantityOnHand > 0, so not oversold negatives either. */
  inStock?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'quantityOnHand' | 'updatedAt' | 'condition';
  sortDir?: 'asc' | 'desc';
}

function toQueryString(filters: InventoryFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const inventoryKeys = {
  list: (filters: InventoryFilters) => ['inventory', 'list', filters] as const,
  detail: (id: string) => ['inventory', 'detail', id] as const,
};

export function useInventoryList(filters: InventoryFilters) {
  return useQuery({
    queryKey: inventoryKeys.list(filters),
    queryFn: () => apiFetch<InventoryPage>(`/inventory${toQueryString(filters)}`),
    // Keeps the previous page on screen while the next one loads, so paging and
    // sorting do not blank the table on every keystroke.
    placeholderData: (previous) => previous,
  });
}

/**
 * Games actually present in the ledger, for the browser's filter.
 *
 * From what is held rather than what the sources declare — a filter that can
 * offer an option returning nothing is worse than one with fewer options.
 * A `null` game is a real bucket: non-TCG goods and hand-entered rows.
 */
export function useInventoryGames() {
  return useQuery({
    queryKey: ['inventory', 'games'],
    queryFn: () => apiFetch<Array<{ game: string | null; items: number }>>('/inventory/games'),
    staleTime: 60_000,
  });
}

/** One item's ledger plus the identity needed to say what it is. */
export type InventoryItemDetail = InventoryRow & {
  externalIds: Record<string, string>;
};

export function useInventoryItem(id: string) {
  return useQuery({
    queryKey: inventoryKeys.detail(id),
    queryFn: () => apiFetch<InventoryItemDetail>(`/inventory/${id}`),
  });
}

/**
 * Server-side dry run behind the allocation editor.
 *
 * The rules deliberately are not reimplemented here: the allocation maths has
 * one authority, and a client-side copy would drift from it silently. The cost
 * is a debounced round trip per edit.
 */
export function usePreviewLedger(id: string) {
  return useMutation({
    mutationFn: (body: {
      quantityOnHand?: number;
      reserveQuantity?: number;
      allocations?: Array<{
        channelInstanceId: string;
        mode: AllocationMode;
        quantityAllocated?: number | null;
        maxQuantity?: number | null;
      }>;
    }) =>
      apiFetch<LedgerPreview>(`/inventory/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

interface MutationOutcome {
  ledger: Ledger;
  changes: Array<{ allocationId: string; channelInstanceId: string; from: number; to: number }>;
  conflicts: Array<{ code: string; message: string; shortfall: number }>;
}

function useLedgerMutation<TArgs>(id: string, request: (args: TArgs) => Promise<MutationOutcome>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (outcome) => {
      // Merged, not replaced. A mutation answers with the *ledger* — quantities
      // and allocations — while the detail cache also holds the item's
      // identity, which no mutation returns. Writing the response straight in
      // blanked the name, set and image the moment anyone adjusted a quantity.
      queryClient.setQueryData<InventoryItemDetail>(inventoryKeys.detail(id), (previous) =>
        previous ? { ...previous, ...outcome.ledger } : undefined,
      );
      // The browse list shows derived quantities, so it is stale after any write.
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] });
    },
  });
}

export function useAdjustQuantity(id: string) {
  return useLedgerMutation(id, (body: { delta: number; reason: string; note?: string }) =>
    apiFetch<MutationOutcome>(`/inventory/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

export function useSetReserve(id: string) {
  return useLedgerMutation(id, (reserveQuantity: number) =>
    apiFetch<MutationOutcome>(`/inventory/${id}/reserve`, {
      method: 'PUT',
      body: JSON.stringify({ reserveQuantity }),
    }),
  );
}

export function useUpsertAllocation(id: string) {
  return useLedgerMutation(
    id,
    (body: {
      channelInstanceId: string;
      mode: AllocationMode;
      quantityAllocated?: number | null;
      maxQuantity?: number | null;
      price?: number | null;
    }) =>
      apiFetch<MutationOutcome>(`/inventory/${id}/allocations`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  );
}

export function useRemoveAllocation(id: string) {
  return useLedgerMutation(id, (channelInstanceId: string) =>
    apiFetch<MutationOutcome>(`/inventory/${id}/allocations/${channelInstanceId}`, {
      method: 'DELETE',
    }),
  );
}

export function useCreateInventoryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      game?: string;
      setName?: string;
      condition: string;
      quantityOnHand?: number;
    }) => apiFetch<Ledger>('/inventory', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] }),
  });
}

/** Cents to a display string. Prices are integers everywhere; never parse them as floats. */
export function formatPrice(cents: number | null, currency = 'USD'): string {
  if (cents === null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}
