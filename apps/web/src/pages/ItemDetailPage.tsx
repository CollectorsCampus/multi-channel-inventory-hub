import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import {
  formatPrice,
  useAdjustQuantity,
  useInventoryItem,
  usePreviewLedger,
  useRemoveAllocation,
  useSetReserve,
  useUpsertAllocation,
  type Allocation,
  type AllocationMode,
  type InventoryItemDetail,
  type Ledger,
} from '../api/inventory';
import { STOCK_MOVEMENT_REASONS } from '../constants';
import { useSyncEvents } from '../api/sync';
import { useChannels } from '../api/channels';

/**
 * Item detail with the allocation editor (§7).
 *
 * Every quantity shown here is derived server-side. The editor validates by
 * posting the proposed ledger to /preview rather than reimplementing the
 * allocation rules, so what the operator sees is exactly what the server will
 * enforce on save.
 */
export function ItemDetailPage() {
  const { id } = useParams({ from: '/items/$id' });
  const { data: ledger, isLoading, error } = useInventoryItem(id);

  if (isLoading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{(error as Error).message}</p>;
  if (!ledger) return null;

  return (
    <section>
      <header className="page-head">
        <div>
          <Link to="/" className="back">
            ← Inventory
          </Link>
          <ItemIdentity item={ledger} />
        </div>
      </header>

      <LedgerSummary ledger={ledger} />
      <QuantityControls ledger={ledger} />
      <AllocationEditor ledger={ledger} />
      <ItemSyncHistory ledger={ledger} />
    </section>
  );
}

/**
 * What this item actually is.
 *
 * The page was headed "Item detail" and showed quantities about a card it never
 * named — you could tell an allocation had three units but not three units of
 * what. Everything here is stored identity, nothing derived.
 *
 * The SKU's three dimensions are shown even at their defaults. On a screen
 * whose whole job is to say which row this is, "NORMAL · EN" is the difference
 * between the plain printing and the foil, and an absent line would read as
 * "unknown" rather than "normal".
 */
function ItemIdentity({ item }: { item: InventoryItemDetail }) {
  const externals = Object.entries(item.externalIds);

  return (
    <div className="item-identity">
      {item.imageUrl && (
        <img className="item-art" src={item.imageUrl} alt="" width={90} height={126} />
      )}
      <div>
        <h1>{item.name}</h1>
        <p className="muted">
          {[item.setName, item.game].filter(Boolean).join(' · ') || 'No set or game recorded'}
        </p>
        <span className="chips">
          <span className="chip">{item.condition}</span>
          <span className="chip">{item.printing}</span>
          <span className="chip">{item.language}</span>
        </span>
        {externals.length > 0 && (
          <p className="field-hint">
            {externals.map(([source, id]) => (
              <span key={source}>
                {source} <code>{id}</code>{' '}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * This item's own sync history (§7).
 *
 * Sync events are keyed by allocation, not by inventory item, so the query is
 * scoped to this item's allocation ids. An item with no allocations has no
 * history by definition and the panel stays out of the way.
 */
function ItemSyncHistory({ ledger }: { ledger: Ledger }) {
  const allocationIds = ledger.allocations.map((a) => a.id);
  const events = useSyncEvents({
    entityIds: allocationIds,
    pageSize: 10,
    enabled: allocationIds.length > 0,
  });

  if (allocationIds.length === 0) return null;

  return (
    <div className="panel">
      <h2>Sync history</h2>

      {events.data?.items.length === 0 && <p className="muted">Nothing pushed to a channel yet.</p>}

      {events.data?.items.map((event) => (
        <p key={event.id} className="muted">
          <span className={`chip outcome-${event.outcome}`}>{event.outcome}</span>{' '}
          {new Date(event.ts).toLocaleString()} · {event.direction} {event.operation}
          {event.channelName ? ` · ${event.channelName}` : ''}
          {event.detail ? ` — ${event.detail}` : ''}
        </p>
      ))}
    </div>
  );
}

function LedgerSummary({ ledger }: { ledger: Ledger }) {
  const committed = ledger.allocations
    .filter((a) => a.mode === 'fixed')
    .reduce((sum, a) => sum + (a.quantityAllocated ?? 0), 0);

  return (
    <div className="stat-row">
      <Stat label="On hand" value={ledger.quantityOnHand} hint="Physical truth" />
      <Stat label="Fixed partitions" value={committed} hint="Committed to channels" />
      <Stat label="Reserved" value={ledger.reserveQuantity} hint="Held back everywhere" />
      <Stat label="Pool" value={ledger.pool} hint="Available to pooled channels" emphasis />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: number;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`stat${emphasis ? ' stat-emphasis' : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}

function QuantityControls({ ledger }: { ledger: Ledger }) {
  const adjust = useAdjustQuantity(ledger.inventoryItemId);
  const setReserve = useSetReserve(ledger.inventoryItemId);

  const [delta, setDelta] = useState('1');
  const [reason, setReason] = useState<string>('intake');
  const [reserve, setReserve_] = useState(String(ledger.reserveQuantity));

  useEffect(() => setReserve_(String(ledger.reserveQuantity)), [ledger.reserveQuantity]);

  const failure = (adjust.error ?? setReserve.error) as Error | null;

  return (
    <div className="panel">
      <h2>Stock</h2>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = Number(delta);
          if (!Number.isInteger(value) || value === 0) return;
          adjust.mutate({ delta: value, reason });
        }}
      >
        <label htmlFor="delta">Adjust by</label>
        <input
          id="delta"
          type="number"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          aria-label="Quantity change, positive or negative"
        />
        <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
          {STOCK_MOVEMENT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit" disabled={adjust.isPending}>
          Apply
        </button>
      </form>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setReserve.mutate(Number(reserve) || 0);
        }}
      >
        <label htmlFor="reserve">Reserve</label>
        <input
          id="reserve"
          type="number"
          min={0}
          value={reserve}
          onChange={(e) => setReserve_(e.target.value)}
        />
        <button type="submit" disabled={setReserve.isPending}>
          Save
        </button>
        <span className="muted">Never listed on any channel.</span>
      </form>

      {failure && <p className="error">{failure.message}</p>}
    </div>
  );
}

/**
 * Where this item is for sale.
 *
 * Rewritten because the previous version asked the operator to **type a channel
 * UUID by hand**, next to a hint saying channel configuration would arrive in
 * Phase 3 — which shipped months earlier. It then labelled each allocation with
 * that same UUID, so the one thing the panel had to answer, "which shop is
 * this", was the one thing it did not say.
 *
 * ## Selling everything you have is the default, and the only visible mode
 *
 * `fixed` and `pooled` are a real distinction and the engine keeps both. But
 * "pooled, uncapped" is what almost every allocation wants — offer whatever is
 * on the shelf — and presenting the choice up front made an ordinary act
 * (sell this on Shopify) look like a decision about partitioning strategy. The
 * modes now live behind **Advanced**, phrased as what they do to the number a
 * customer sees rather than as the internal vocabulary.
 *
 * Nothing about the engine changed: this screen still posts whole allocations
 * and still validates by asking `/preview`, so what is shown is what the server
 * will enforce.
 */
function AllocationEditor({ ledger }: { ledger: Ledger }) {
  const remove = useRemoveAllocation(ledger.inventoryItemId);
  const channels = useChannels();

  /**
   * A channel's name, with its connector when the name alone is ambiguous.
   *
   * Two channels may legitimately share a display name — the store this was
   * built for has a Shopify and a TCGPlayer channel both called "Collector's
   * Campus", which is the seller's own name and the obvious thing to type
   * twice. Showing the name alone makes the two rows indistinguishable, and
   * appending the connector unconditionally clutters the common case where
   * they are already distinct.
   */
  const named = (id: string) => {
    const channel = channels.data?.find((c) => c.id === id);
    if (!channel) return id;

    const ambiguous =
      (channels.data ?? []).filter((c) => c.displayName === channel.displayName).length > 1;

    return ambiguous ? `${channel.displayName} (${channel.connectorKey})` : channel.displayName;
  };

  return (
    <div className="panel">
      <h2>Selling channels</h2>

      {ledger.allocations.length === 0 && (
        <p className="muted">
          Not for sale anywhere. All {ledger.quantityOnHand} unit(s) sit unallocated.
        </p>
      )}

      {ledger.allocations.map((allocation) => (
        <AllocationRow
          key={allocation.id}
          ledger={ledger}
          allocation={allocation}
          channelName={named(allocation.channelInstanceId)}
          onRemove={() => remove.mutate(allocation.channelInstanceId)}
        />
      ))}

      <AddAllocation ledger={ledger} />
      {remove.isError && <p className="error">{(remove.error as Error).message}</p>}
    </div>
  );
}

function AllocationRow({
  ledger,
  allocation,
  channelName,
  onRemove,
}: {
  ledger: Ledger;
  allocation: Allocation;
  channelName: string;
  onRemove: () => void;
}) {
  const save = useUpsertAllocation(ledger.inventoryItemId);
  const preview = usePreviewLedger(ledger.inventoryItemId);

  const [mode, setMode] = useState<AllocationMode>(allocation.mode);
  const [quantity, setQuantity] = useState(String(allocation.quantityAllocated ?? 0));
  const [cap, setCap] = useState(
    allocation.maxQuantity === null ? '' : String(allocation.maxQuantity),
  );
  const [price, setPrice] = useState(
    allocation.price === null ? '' : String(allocation.price / 100),
  );

  // Live validation: ask the server what this edit would do, debounced.
  useEffect(() => {
    const handle = setTimeout(() => {
      preview.mutate({
        allocations: ledger.allocations.map((a) =>
          a.id === allocation.id
            ? {
                channelInstanceId: a.channelInstanceId,
                mode,
                quantityAllocated: mode === 'fixed' ? Number(quantity) || 0 : null,
                maxQuantity: mode === 'pooled' && cap !== '' ? Number(cap) : null,
              }
            : {
                channelInstanceId: a.channelInstanceId,
                mode: a.mode,
                quantityAllocated: a.quantityAllocated,
                maxQuantity: a.maxQuantity,
              },
        ),
      });
    }, 250);
    return () => clearTimeout(handle);
    // `preview` is a stable mutation object; including it would re-fire endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, quantity, cap, ledger.allocations, allocation.id]);

  // Preview keys everything by channelInstanceId, since a proposed allocation
  // need not exist yet.
  const issues =
    preview.data?.issues.filter(
      (i) => !i.allocationId || i.allocationId === allocation.channelInstanceId,
    ) ?? [];
  const blocked = (preview.data?.issues.length ?? 0) > 0;

  return (
    <div className="allocation">
      <div className="allocation-head">
        {/* The channel's name, not its id. This is the question the panel
            exists to answer and it used to print a UUID instead. */}
        <strong>{channelName}</strong>
        <span className="chip">showing {allocation.desiredListedQuantity}</span>
        <span className="muted">{allocation.status}</span>
        {/* Whether a listing is actually attached is the difference between an
            allocation that syncs and one that silently never will. */}
        {allocation.externalListingId ? (
          <span className="muted" title={allocation.externalListingId}>
            · linked
          </span>
        ) : (
          <span className="muted">· not linked to a listing yet</span>
        )}
      </div>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            channelInstanceId: allocation.channelInstanceId,
            mode,
            quantityAllocated: mode === 'fixed' ? Number(quantity) || 0 : null,
            maxQuantity: mode === 'pooled' && cap !== '' ? Number(cap) : null,
            price: price === '' ? null : Math.round(Number(price) * 100),
          });
        }}
      >
        <label htmlFor={`price-${allocation.id}`}>Price</label>
        <input
          id={`price-${allocation.id}`}
          type="number"
          step="0.01"
          min={0}
          value={price}
          placeholder="not set"
          onChange={(e) => setPrice(e.target.value)}
        />
        {/* The currency was missing entirely, so the box could as easily have
            been read as cents. It comes from the allocation, not a constant. */}
        <span className="muted">{allocation.currency}</span>

        <button type="submit" disabled={save.isPending || blocked}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onRemove}>
          Stop selling here
        </button>
      </form>

      <details className="quiet-details">
        <summary>Advanced — how much of the stock this channel may show</summary>

        <div className="inline-form">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AllocationMode)}
            aria-label="How this channel draws from stock"
          >
            <option value="pooled">Show whatever is in stock</option>
            <option value="fixed">Reserve a fixed number for this channel</option>
          </select>

          {mode === 'fixed' ? (
            <>
              <label htmlFor={`qty-${allocation.id}`}>Units reserved</label>
              <input
                id={`qty-${allocation.id}`}
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor={`cap-${allocation.id}`}>Never show more than</label>
              <input
                id={`cap-${allocation.id}`}
                type="number"
                min={0}
                value={cap}
                placeholder="no limit"
                onChange={(e) => setCap(e.target.value)}
              />
            </>
          )}
        </div>

        <p className="field-hint">
          {mode === 'pooled'
            ? 'Shared: this channel and every other pooled one all offer the same stock, so ' +
              'whichever sells first takes it. A limit caps what is shown, not what is held.'
            : 'Exclusive: these units are held for this channel and no other channel can offer ' +
              'them, even when nothing else is selling.'}{' '}
          Both changes take effect on <strong>Save</strong> above.
        </p>
      </details>

      {preview.data && !blocked && (
        <p className="muted">
          Would show <strong>{preview.data.listed[allocation.channelInstanceId] ?? 0}</strong> here
          · shared pool becomes <strong>{preview.data.pool}</strong>
        </p>
      )}
      {issues.map((issue) => (
        <p key={issue.code + issue.message} className="error">
          {issue.message}
        </p>
      ))}
      {save.isError && <p className="error">{(save.error as Error).message}</p>}
    </div>
  );
}

/**
 * Put this item on another channel.
 *
 * Previously a text box for a channel **UUID**, which had to be found by
 * reading the database or the network tab, beside a note promising channel
 * management "in Phase 3" — a phase that had shipped. It is a dropdown of the
 * channels that exist, and only the ones this item is not already on.
 *
 * New allocations are pooled and uncapped, which is the sensible default: offer
 * whatever is on the shelf. Anything else is one disclosure away on the row it
 * creates, so the common case is a single click.
 */
function AddAllocation({ ledger }: { ledger: Ledger }) {
  const save = useUpsertAllocation(ledger.inventoryItemId);
  const channels = useChannels();
  const [channelInstanceId, setChannelInstanceId] = useState('');

  const taken = new Set(ledger.allocations.map((a) => a.channelInstanceId));
  // Offering a channel the item is already on would produce an "edit" wearing
  // an "add" label, and silently overwrite the settings on the row above.
  const available = (channels.data ?? []).filter((c) => c.enabled && !taken.has(c.id));

  if (channels.isError) {
    return <p className="field-hint">Channels could not be loaded, so none can be added here.</p>;
  }

  if (channels.data && available.length === 0) {
    return (
      <p className="field-hint">
        {taken.size > 0
          ? 'This item is on every enabled channel.'
          : 'No channels are connected yet. Connect one first.'}{' '}
        <Link to="/channels">Channels →</Link>
      </p>
    );
  }

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!channelInstanceId) return;
        save.mutate(
          {
            channelInstanceId,
            mode: 'pooled',
            quantityAllocated: null,
            maxQuantity: null,
          },
          { onSuccess: () => setChannelInstanceId('') },
        );
      }}
    >
      <label htmlFor="add-channel">Also sell on</label>
      <select
        id="add-channel"
        value={channelInstanceId}
        onChange={(e) => setChannelInstanceId(e.target.value)}
      >
        <option value="">Choose a channel…</option>
        {available.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {/* Always qualified here: the list is short, the reader is choosing
                between them, and two channels sharing a name is normal — it is
                usually the seller's own business name. */}
            {channel.displayName} ({channel.connectorKey})
          </option>
        ))}
      </select>

      <button type="submit" disabled={save.isPending || channelInstanceId === ''}>
        Add
      </button>

      {save.isError && <p className="error">{(save.error as Error).message}</p>}
    </form>
  );
}

export { formatPrice };
