import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Creating listings on a channel for stock the ledger already holds.
 *
 * The other half of matching: that one links listings that exist, this one
 * makes ones that do not.
 */

export type CreateListingOutcome =
  'created-product' | 'added-variant' | 'already-existed' | 'already-linked';

export interface CreatedListing {
  inventoryItemId: string;
  name: string;
  sku: string;
  externalListingId: string;
  outcome: CreateListingOutcome;
}

export interface CreateListingsResult {
  listings: CreatedListing[];
  problems: Array<{ inventoryItemId: string; name?: string; message: string }>;
}

export interface CreateListingsRequest {
  inventoryItemIds: string[];
  tags?: string[];
  vendor?: string;
  optionName?: string;
}

/** Most items one run may create. Mirrors `MAX_ITEMS` on the server. */
export const MAX_ITEMS = 50;

/**
 * The tags the channel's own products already carry.
 *
 * A query rather than a mutation: it reads and it is wanted as soon as the
 * screen opens. Cached for the session — a store's tag vocabulary changes when
 * someone adds a collection, not while a form is open.
 */
export function useChannelTags(channelInstanceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['channels', channelInstanceId, 'tags'],
    queryFn: () => apiFetch<string[]>(`/channels/${channelInstanceId}/listings/tags`),
    enabled: enabled && channelInstanceId !== '',
    staleTime: 5 * 60 * 1000,
    // A store that cannot report its tags is not a reason to stop: the field
    // stays typeable, and the operator is told the list is unavailable.
    retry: false,
  });
}

export function useCreateListings(channelInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateListingsRequest) =>
      apiFetch<CreateListingsResult>(`/channels/${channelInstanceId}/listings`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // Creation writes allocations, so the browse list's derived quantities and
    // the channel cards are both stale afterwards.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function describeOutcome(outcome: CreateListingOutcome): string {
  switch (outcome) {
    case 'created-product':
      return 'new product';
    case 'added-variant':
      return 'variant added';
    case 'already-existed':
      return 'already on the channel';
    case 'already-linked':
      return 'already linked';
  }
}
