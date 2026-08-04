import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface CatalogSourceSummary {
  key: string;
  displayName: string;
  description?: string;
  games: string[];
  providesExternalIds: string[];
  /** Whether the source can fill the local catalog (bulk ingest). */
  canIngest: boolean;
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

// ---------------------------------------------------------------------------
// The local catalog — what has been ingested, served from our own database.
// ---------------------------------------------------------------------------

export interface LocalSetSummary {
  game: string | null;
  setName: string;
  items: number;
}

/**
 * What a clear would remove, or did remove.
 *
 * `protectedCount` is shown alongside `clearable` deliberately: the reassuring
 * fact here is not the number that goes away, it is the number that provably
 * cannot — because it holds a SKU, at any quantity.
 */
export interface CatalogClearPreview {
  clearable: number;
  protectedCount: number;
}

export interface CatalogClearReport extends CatalogClearPreview {
  externalRefsRemoved: number;
}

/**
 * Fetched only when requested, and with no cached staleness window: the
 * operator asked what a destructive action would do right now, not a few
 * minutes ago.
 */
export function useCatalogClearPreview(game: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog', 'local', 'clear-preview', game],
    queryFn: () => {
      const params = new URLSearchParams();
      if (game) params.set('game', game);
      const qs = params.toString();
      return apiFetch<CatalogClearPreview>(`/catalog/local/clear-preview${qs ? `?${qs}` : ''}`);
    },
    enabled,
    staleTime: 0,
  });
}

export function useClearCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { game?: string }) =>
      apiFetch<CatalogClearReport>('/catalog/local/clear', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog', 'local'] }),
  });
}

export function useLocalSets(game?: string) {
  return useQuery({
    queryKey: ['catalog', 'local', 'sets', game],
    queryFn: () => {
      const params = new URLSearchParams();
      if (game) params.set('game', game);
      const qs = params.toString();
      return apiFetch<LocalSetSummary[]>(`/catalog/local/sets${qs ? `?${qs}` : ''}`);
    },
    staleTime: 60_000,
  });
}

export function useLocalSearch(text: string, game?: string, setName?: string) {
  const trimmed = text.trim();
  const set = setName?.trim();
  return useQuery({
    queryKey: ['catalog', 'local', 'search', trimmed, game, set],
    queryFn: () => {
      const params = new URLSearchParams({ text: trimmed, limit: '100' });
      if (game) params.set('game', game);
      if (set) params.set('setName', set);
      return apiFetch<{ candidates: CatalogCandidate[] }>(
        `/catalog/local/search?${params.toString()}`,
      );
    },
    // Unlike the remote search this is our own database, so a set alone — the
    // browse case — is a valid query and there is no rate limit to protect.
    enabled: trimmed.length >= 2 || Boolean(set),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Ingest — filling the local catalog from a source. Admin only.
// ---------------------------------------------------------------------------

export interface IngestableSet {
  setId: string;
  name: string;
  game?: string;
  releasedAt?: string;
}

export function useIngestableSets(sourceKey: string, game: string, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog', 'ingest', 'sets', sourceKey, game],
    queryFn: () => {
      const params = new URLSearchParams({ sourceKey });
      if (game) params.set('game', game);
      return apiFetch<IngestableSet[]>(`/catalog/ingest/sets?${params.toString()}`);
    },
    // Listing a source's sets is a third-party call; only on request.
    enabled,
    staleTime: 5 * 60_000,
  });
}

export interface IngestReport {
  sourceKey: string;
  sets: number;
  products: number;
  created: number;
  refreshed: number;
  unchanged: number;
  problems: Array<{ set: string; message: string }>;
  durationMs: number;
}

/**
 * The server's default ceiling on sets per run, mirrored here.
 *
 * It exists so "ingest everything" cannot cost thousands of requests before
 * anyone notices, and the server **refuses** rather than truncating — a
 * half-ingested game that looks complete is worse than a rejected run. So a
 * deliberately large selection has to raise it, and the screen says what that
 * costs before it does.
 */
export const DEFAULT_MAX_SETS = 50;

export function useRunIngest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { sourceKey: string; game?: string; setIds?: string[]; maxSets?: number }) =>
      apiFetch<IngestReport>('/catalog/ingest', { method: 'POST', body: JSON.stringify(body) }),
    // The local catalog just changed; every local view is stale.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog', 'local'] }),
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
