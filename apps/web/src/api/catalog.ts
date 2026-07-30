import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface CatalogSourceSummary {
  key: string;
  displayName: string;
  description?: string;
  games: string[];
  providesExternalIds: string[];
}

export interface CatalogCandidate {
  sourceKey: string;
  sourceId: string;
  name: string;
  game?: string;
  setName?: string;
  imageUrl?: string;
  /** Keyed by platform. A key is absent when the source has no id for it. */
  externalIds: Record<string, string>;
  marketPrice?: number;
  printings?: string[];
  language?: string;
}

export interface CatalogSearchResponse {
  candidates: CatalogCandidate[];
  /** Sources that were unreachable. The search still returns what did answer. */
  failures: Array<{ sourceKey: string; message: string }>;
}

export function useCatalogSources() {
  return useQuery({
    queryKey: ['catalog', 'sources'],
    queryFn: () => apiFetch<CatalogSourceSummary[]>('/catalog/sources'),
    staleTime: 5 * 60_000,
  });
}

export function useCatalogSearch(text: string, game?: string, setName?: string) {
  const trimmed = text.trim();
  const set = setName?.trim();
  return useQuery({
    queryKey: ['catalog', 'search', trimmed, game, set],
    queryFn: () => {
      const params = new URLSearchParams({ text: trimmed, limit: '25' });
      if (game) params.set('game', game);
      // tcgcsv cannot answer without one — it has no search endpoint and would
      // otherwise have to download a whole category.
      if (set) params.set('setName', set);
      return apiFetch<CatalogSearchResponse>(`/catalog/search?${params.toString()}`);
    },
    // Catalog sources are third-party services under someone else's rate
    // limits; only ask once the operator has typed something meaningful.
    enabled: trimmed.length >= 3,
    staleTime: 60_000,
  });
}

export interface IntakeRequest {
  sourceKey: string;
  sourceId: string;
  condition: string;
  printing?: string;
  language?: string;
  quantity: number;
  costBasis?: number;
}

export interface IntakeResult {
  ledger: { inventoryItemId: string; quantityOnHand: number; pool: number };
  catalogItemId: string;
  skuId: string;
  createdCatalogItem: boolean;
  createdSku: boolean;
  externalIds: Record<string, string>;
}

export function useIntake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IntakeRequest) =>
      apiFetch<IntakeResult>('/inventory/intake', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] }),
  });
}
