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

export interface ListingMetafield {
  owner: 'product' | 'variant';
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface ListingMetafieldDefinition {
  owner: 'product' | 'variant';
  namespace: string;
  key: string;
  type: string;
  name: string;
  /** Absent on a free-text field; present and empty means the store has none. */
  choices?: Array<{ value: string; label: string }>;
  /** Present means the vocabulary could not be read — never treat as "none". */
  unavailable?: string;
}

export interface CreateListingsRequest {
  inventoryItemIds: string[];
  tags?: string[];
  metafields?: ListingMetafield[];
  vendor?: string;
  optionName?: string;
}

/**
 * The custom fields the channel models.
 *
 * Cached like the tag vocabulary: a store's metafield definitions change when
 * someone adds one, not while a form is open. Reading it costs the channel
 * several requests, so it is worth not repeating on every focus.
 */
export function useChannelMetafields(channelInstanceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['channels', channelInstanceId, 'metafields'],
    queryFn: () =>
      apiFetch<ListingMetafieldDefinition[]>(`/channels/${channelInstanceId}/listings/metafields`),
    enabled: enabled && channelInstanceId !== '',
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
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
