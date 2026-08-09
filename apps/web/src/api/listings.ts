import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { IntakeResult } from './catalog';

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

export interface ListingCategory {
  id: string;
  label: string;
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
  /** Categories the field is restricted to. A listing needs one of them. */
  requiresCategory?: ListingCategory[];
}

/**
 * The categories every chosen field will accept — their intersection.
 *
 * Conditional metafield definitions are the reason this exists: `custom.game`
 * applies only to "Gaming Cards", so a product with no category has the field
 * rejected with a message naming neither. Where the chosen fields share exactly
 * one category there is nothing to ask the operator, because the constraints
 * have already decided.
 *
 * An **empty** result is worth telling them about: it means two chosen fields
 * cannot both apply to one product, and the run will fail whatever is picked.
 */
export function requiredCategories(
  definitions: readonly ListingMetafieldDefinition[],
  chosen: readonly ListingMetafield[],
): ListingCategory[] | undefined {
  const constrained = definitions.filter(
    (d) =>
      (d.requiresCategory?.length ?? 0) > 0 &&
      chosen.some((f) => f.owner === d.owner && f.namespace === d.namespace && f.key === d.key),
  );
  if (constrained.length === 0) return undefined;

  return constrained.reduce<ListingCategory[]>(
    (common, definition) =>
      common.filter((c) => definition.requiresCategory!.some((other) => other.id === c.id)),
    [...constrained[0]!.requiresCategory!],
  );
}

export interface CreateListingsRequest {
  inventoryItemIds: string[];
  tags?: string[];
  metafields?: ListingMetafield[];
  category?: string;
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

/**
 * The sales channels the channel can publish a created product to.
 *
 * Cached like the tag and metafield vocabularies. A connector without
 * `listing.publications` answers with an error, so `retry: false` and the caller
 * treats a failure as "not available here".
 */
export function useChannelPublications(channelInstanceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['channels', channelInstanceId, 'publications'],
    queryFn: () =>
      apiFetch<{ id: string; name: string }[]>(
        `/channels/${channelInstanceId}/listings/publications`,
      ),
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

/**
 * Take stock in and list it on a channel, in one call.
 *
 * The listing fields are omitted entirely so the channel's stored defaults
 * apply — which is the whole point of declaring them. Sending `tags: []` here
 * would mean "no tags", not "use the defaults", and would quietly produce
 * products in no collection.
 */
export interface IntakeAndListRequest {
  sourceKey: string;
  sourceId: string;
  condition: string;
  printing?: string;
  language?: string;
  quantity: number;
  /** What it cost you, in cents. Belongs to the ledger. */
  costBasis?: number;
  /** What a customer pays, in cents. Belongs to the channel. */
  price?: number;
}

export interface IntakeAndListResult {
  intake: IntakeResult;
  listing: CreateListingsResult;
}

export function useIntakeAndList(channelInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IntakeAndListRequest) =>
      apiFetch<IntakeAndListResult>(`/channels/${channelInstanceId}/listings/intake`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // Both halves write: intake moves stock, creation writes an allocation.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
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
