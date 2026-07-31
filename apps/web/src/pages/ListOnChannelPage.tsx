import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useChannels } from '../api/channels';
import { useInventoryList, type InventoryRow } from '../api/inventory';
import {
  describeOutcome,
  useChannelTags,
  useCreateListings,
  MAX_ITEMS,
  type CreateListingsResult,
} from '../api/listings';
import { SKU_CONDITIONS } from '../constants';

/**
 * Put stock the ledger holds onto a channel that does not carry it (§7).
 *
 * ## Selection is the feature
 *
 * The operator's constraint, and the reason this is a screen rather than a
 * background job: it "probably shouldn't be automatic to create everything
 * that is in say your tcgplayer export". So nothing here acts on a filter —
 * the filter narrows what is *offered*, and only ticked rows are sent. There
 * is deliberately no "select all", and the run is capped at {@link MAX_ITEMS}.
 *
 * ## Tags are picked, never derived
 *
 * On a real store every collection is a smart collection keyed on one exact
 * tag, and catalogue names are not those tags — `Pokemon` against `Pokémon`,
 * `Magic` against `Magic: The Gathering`. A tag the hub guessed would put the
 * product in no collection at all: present in the admin, invisible in the
 * shop, and reported by nothing. So the field offers the store's own
 * vocabulary and no default, and blank means no tags.
 */
export function ListOnChannelPage() {
  const channels = useChannels();

  const [channelId, setChannelId] = useState('');
  const [search, setSearch] = useState('');
  const [game, setGame] = useState('');
  const [condition, setCondition] = useState('');
  const [page, setPage] = useState(1);

  // Kept as id → name so the summary survives paging and filtering: a row that
  // scrolls out of the current page is still selected, and saying so needs its
  // name.
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [vendor, setVendor] = useState('');

  // Only channels that can bring a listing into existence. Offering a
  // file-based channel here would be an invitation to an error message.
  const creatable = (channels.data ?? []).filter((c) => c.capabilities.includes('listing.create'));

  useEffect(() => {
    if (!channelId && creatable[0]) setChannelId(creatable[0].id);
  }, [channelId, creatable]);

  const inventory = useInventoryList({
    ...(search ? { search } : {}),
    ...(game ? { game } : {}),
    ...(condition ? { condition } : {}),
    page,
    pageSize: 25,
  });

  const create = useCreateListings(channelId);
  const selectedIds = Object.keys(selected);
  const overCap = selectedIds.length > MAX_ITEMS;

  const toggle = (row: InventoryRow, on: boolean) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (on) next[row.inventoryItemId] = row.name;
      else delete next[row.inventoryItemId];
      return next;
    });

  return (
    <section>
      <header className="page-head">
        <div>
          <Link to="/channels" className="back">
            ← Channels
          </Link>
          <h1>List on a channel</h1>
          <p className="muted">
            Create listings for stock this channel does not carry. Created as drafts with no
            quantity — publishing stays yours, and stock follows through the normal sync.
          </p>
        </div>
      </header>

      <div className="panel">
        {channels.isSuccess && creatable.length === 0 && (
          <p className="muted">
            No channel here can create a listing. A file-based channel is listed by uploading its
            own export instead — see the <Link to="/channels">channels page</Link>.
          </p>
        )}

        <div className="filters">
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            aria-label="Channel"
          >
            {creatable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </div>

        <TagPicker channelId={channelId} tags={tags} onChange={setTags} />

        <div className="inline-form">
          <label htmlFor="create-vendor">Vendor</label>
          <input
            id="create-vendor"
            type="text"
            placeholder="Publisher — optional"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
        </div>
        <p className="field-hint">
          Applied verbatim to products this run creates. A variant added to a product you already
          have keeps that product&apos;s vendor and tags.
        </p>
      </div>

      <div className="panel">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
          }}
        >
          <input
            type="search"
            placeholder="Search the ledger"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
          <input
            type="text"
            placeholder="Game"
            value={game}
            onChange={(e) => setGame(e.target.value)}
            aria-label="Game"
          />
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            aria-label="Condition"
          >
            <option value="">Any condition</option>
            {SKU_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="submit">Search</button>
        </form>

        {/* No "select all", on purpose: a filter is not a decision, and the one
            thing this screen must not do is turn an import into a storefront. */}
        <table className="grid">
          <thead>
            <tr>
              <th aria-label="Selected" />
              <th>Item</th>
              <th>SKU</th>
              <th>On hand</th>
              <th>On this channel</th>
            </tr>
          </thead>
          <tbody>
            {(inventory.data?.items ?? []).map((row) => {
              const listed = row.allocations.find(
                (a) => a.channelInstanceId === channelId,
              )?.externalListingId;

              return (
                <tr key={row.inventoryItemId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      checked={selected[row.inventoryItemId] !== undefined}
                      // Already driving a listing: creating would be a no-op the
                      // operator has to read a report to discover.
                      disabled={listed != null}
                      onChange={(e) => toggle(row, e.target.checked)}
                    />
                  </td>
                  <td>
                    <span className="cell-title">{row.name}</span>
                    <span className="cell-sub">
                      {[row.setName, row.game].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  <td>
                    {row.condition} · {row.printing} · {row.language}
                  </td>
                  <td>{row.quantityOnHand}</td>
                  <td>
                    {listed ? (
                      <span className="chip chip-pooled">listed</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {inventory.isSuccess && (inventory.data?.items.length ?? 0) === 0 && (
          <p className="muted">Nothing in the ledger matches that.</p>
        )}

        <div className="inline-form">
          <button
            type="button"
            className="ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Previous
          </button>
          <span className="muted">
            Page {inventory.data?.page ?? 1} of {inventory.data?.pageCount ?? 1}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={page >= (inventory.data?.pageCount ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="inline-form">
          <button
            type="button"
            disabled={selectedIds.length === 0 || overCap || channelId === '' || create.isPending}
            onClick={() =>
              create.mutate({
                inventoryItemIds: selectedIds,
                ...(tags.length > 0 ? { tags } : {}),
                ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
              })
            }
          >
            {create.isPending
              ? 'Creating…'
              : `Create ${selectedIds.length} listing${selectedIds.length === 1 ? '' : 's'}`}
          </button>
          {selectedIds.length > 0 && (
            <button type="button" className="ghost" onClick={() => setSelected({})}>
              Clear selection
            </button>
          )}
        </div>

        {overCap && (
          <p className="error">
            {selectedIds.length} selected. One run creates at most {MAX_ITEMS} — a batch larger than
            someone will check afterwards is how a store fills with products nobody meant.
          </p>
        )}

        {selectedIds.length > 0 && !overCap && (
          <p className="field-hint">
            {Object.values(selected).slice(0, 6).join(', ')}
            {selectedIds.length > 6 && ` and ${selectedIds.length - 6} more`}. Two conditions of one
            card become one product with a variant each.
          </p>
        )}

        {create.isError && <p className="error">{(create.error as Error).message}</p>}
        {create.isSuccess && create.data && <Report result={create.data} />}
      </div>
    </section>
  );
}

/**
 * Tags, chosen from what the store already says.
 *
 * A datalist rather than a select: the vocabulary is a suggestion list, and a
 * store that cannot report its tags — or a tag genuinely being used for the
 * first time — must still be typeable. No default is offered, because a
 * default here is the hub deriving a tag by another name.
 */
function TagPicker({
  channelId,
  tags,
  onChange,
}: {
  channelId: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const vocabulary = useChannelTags(channelId, channelId !== '');

  const add = () => {
    const tag = draft.trim();
    if (tag === '' || tags.includes(tag)) return setDraft('');
    onChange([...tags, tag]);
    setDraft('');
  };

  const known = vocabulary.data ?? [];
  const unknown = tags.filter((tag) => known.length > 0 && !known.includes(tag));

  return (
    <>
      <div className="inline-form">
        <label htmlFor="create-tag">Tags</label>
        <input
          id="create-tag"
          type="text"
          list="channel-tags"
          placeholder={vocabulary.isSuccess ? 'Start typing — the store’s own tags' : 'Tag'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Otherwise Enter submits the search form above it.
            e.preventDefault();
            add();
          }}
        />
        <datalist id="channel-tags">
          {known.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <button type="button" className="ghost" onClick={add}>
          Add tag
        </button>
      </div>

      {tags.length > 0 && (
        <span className="chips">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="chip"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              aria-label={`Remove tag ${tag}`}
            >
              {tag} ×
            </button>
          ))}
        </span>
      )}

      <p className="field-hint">
        {vocabulary.isError
          ? 'This channel could not list its tags, so nothing is suggested. Copy them exactly from the platform.'
          : 'Tags decide which collections a product appears in, and they are matched exactly. A tag the store does not already use usually means a product nobody can find.'}
      </p>

      {unknown.length > 0 && (
        <p className="error">
          {unknown.join(', ')} {unknown.length === 1 ? 'is' : 'are'} not a tag this store already
          uses. That is allowed — but if it is a typo, the product lands in no collection.
        </p>
      )}
    </>
  );
}

function Report({ result }: { result: CreateListingsResult }) {
  return (
    <div className="import-result">
      <p className={result.problems.length > 0 ? 'outcome-conflict' : 'outcome-ok'}>
        {result.listings.length} listing{result.listings.length === 1 ? '' : 's'} on the channel
        {result.problems.length > 0 && `, ${result.problems.length} failed`}.
      </p>

      <ul className="candidates">
        {result.listings.map((listing) => (
          <li key={listing.inventoryItemId}>
            <span className="cell-title">{listing.name}</span>
            <span className="cell-sub">
              <code>{listing.sku}</code> · <code>{listing.externalListingId}</code>
            </span>
            <span className="chips">
              <span className="chip">{describeOutcome(listing.outcome)}</span>
            </span>
          </li>
        ))}
      </ul>

      {/* Each item is independent, so the ones that failed are named rather than
          losing the whole batch. */}
      <ul className="error">
        {result.problems.map((problem) => (
          <li key={problem.inventoryItemId}>
            {problem.name ?? problem.inventoryItemId}: {problem.message}
          </li>
        ))}
      </ul>

      <p className="field-hint">
        Nothing is on sale yet. Each product is a draft with no quantity — publish it on the
        platform, and stock reaches it on the next sync.
      </p>
    </div>
  );
}
