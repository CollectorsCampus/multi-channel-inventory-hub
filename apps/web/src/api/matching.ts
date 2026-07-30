import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Linking a channel's existing listings to inventory.
 *
 * `propose` is a mutation rather than a query, even though it writes nothing: it
 * names a set, downloads a set file and walks a page of the channel, and the
 * operator triggers it deliberately. Modelling it as a query would have React
 * Query refetch it on focus, which means re-downloading a set file because
 * someone switched tabs.
 */

export type MatchConfidence = 'certain' | 'probable' | 'possible';

export type MatchReason =
  'barcode' | 'external-id' | 'external-id-embedded' | 'name-and-set' | 'name' | 'name-partial';

export interface ChannelListing {
  externalListingId: string;
  title: string;
  sku?: string;
  barcode?: string;
  price?: number;
  currency?: string;
  active?: boolean;
}

export interface MatchTarget {
  id: string;
  name: string;
  setName?: string;
  game?: string;
  externalIds?: Record<string, string>;
}

export interface MatchCandidate {
  target: MatchTarget;
  reason: MatchReason;
  confidence: MatchConfidence;
  detail: string;
}

export interface DerivedDimensions {
  condition: string;
  printing: string;
  language: string;
}

export type MatchProposal = {
  listing: ChannelListing;
  /** What the listing title implied. Absent when it implied nothing. */
  derived?: DerivedDimensions;
} & (
  | { status: 'matched'; candidate: MatchCandidate }
  | { status: 'ambiguous'; candidates: MatchCandidate[] }
  | { status: 'unmatched' }
);

export interface ProposalSummary {
  matched: number;
  ambiguous: number;
  unmatched: number;
  certain: number;
}

export interface ProposeResponse {
  proposals: MatchProposal[];
  summary: ProposalSummary;
  skipped: number;
  nextCursor?: string;
  candidateCount: number;
}

export interface ProposeRequest {
  channelInstanceId: string;
  sourceKey: string;
  setName: string;
  game?: string;
  cursor?: string;
  limit?: number;
}

export interface ConfirmLink {
  externalListingId: string;
  sourceKey: string;
  sourceId: string;
  condition: string;
  printing?: string;
  language?: string;
  price?: number;
}

export interface ConfirmResult {
  linked: number;
  unchanged: number;
  problems: Array<{ externalListingId: string; message: string }>;
}

export function useProposeMatches() {
  return useMutation({
    mutationFn: ({ channelInstanceId, ...body }: ProposeRequest) =>
      apiFetch<ProposeResponse>(`/channels/${channelInstanceId}/match/propose`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

export function useConfirmMatches(channelInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (links: ConfirmLink[]) =>
      apiFetch<ConfirmResult>(`/channels/${channelInstanceId}/match/confirm`, {
        method: 'POST',
        body: JSON.stringify({ links }),
      }),
    // Confirmation creates inventory items and allocations, so both browse
    // views are stale afterwards.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/** Short label for a match reason, for a chip in the review list. */
export function describeReason(reason: MatchReason): string {
  switch (reason) {
    case 'barcode':
      return 'barcode';
    case 'external-id':
      return 'id match';
    case 'external-id-embedded':
      return 'id in SKU';
    case 'name-and-set':
      return 'name + set';
    case 'name':
      return 'name';
    case 'name-partial':
      return 'partial name';
  }
}
