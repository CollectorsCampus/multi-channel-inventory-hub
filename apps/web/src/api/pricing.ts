import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Repricing: the review queue and the on-demand sweep.
 *
 * The policy itself is channel data and travels through the channels API
 * (`repricingPolicy` on PATCH), the same as listing defaults.
 */

export interface RepricingPolicy {
  enabled?: boolean;
  conditionPercents?: Record<string, number>;
  rounding?: 'none' | '99';
  floorCents?: number;
  autoApplyMaxPct?: number;
  minDeltaCents?: number;
}

export interface RepriceProposal {
  id: string;
  allocationId: string;
  channelInstanceId: string;
  channelName: string;
  name: string;
  setName: string | null;
  condition: string;
  printing: string;
  currentPrice: number | null;
  proposedPrice: number;
  marketPrice: number;
  source: string;
  basis: string;
  createdAt: string;
}

export interface SweepReport {
  itemsConsidered: number;
  pricesRecorded: number;
  autoApplied: number;
  proposed: number;
  problems: string[];
}

const proposalKeys = { list: ['pricing', 'proposals'] as const };

export function useRepriceProposals(enabled: boolean) {
  return useQuery({
    queryKey: proposalKeys.list,
    queryFn: () => apiFetch<RepriceProposal[]>('/pricing/proposals'),
    enabled,
  });
}

export function useRepriceSweep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SweepReport>('/pricing/sweep', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: proposalKeys.list });
      // Auto-applied prices change allocations the inventory views show.
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

function useProposalAction(action: 'apply' | 'dismiss') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/pricing/proposals/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: proposalKeys.list });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useApplyProposal() {
  return useProposalAction('apply');
}

export function useDismissProposal() {
  return useProposalAction('dismiss');
}
