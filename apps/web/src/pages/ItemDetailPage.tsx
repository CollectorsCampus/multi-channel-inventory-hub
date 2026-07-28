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
  type Ledger,
} from '../api/inventory';
import { STOCK_MOVEMENT_REASONS } from '../constants';

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
          <h1>Item detail</h1>
        </div>
      </header>

      <LedgerSummary ledger={ledger} />
      <QuantityControls ledger={ledger} />
      <AllocationEditor ledger={ledger} />
    </section>
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

function AllocationEditor({ ledger }: { ledger: Ledger }) {
  const remove = useRemoveAllocation(ledger.inventoryItemId);

  return (
    <div className="panel">
      <h2>Channel allocations</h2>

      {ledger.allocations.length === 0 && (
        <p className="muted">
          Not listed anywhere. All {ledger.quantityOnHand} unit(s) sit unallocated.
        </p>
      )}

      {ledger.allocations.map((allocation) => (
        <AllocationRow
          key={allocation.id}
          ledger={ledger}
          allocation={allocation}
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
  onRemove,
}: {
  ledger: Ledger;
  allocation: Allocation;
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
        <code>{allocation.channelInstanceId}</code>
        <span className={`chip chip-${allocation.mode}`}>
          listing {allocation.desiredListedQuantity}
        </span>
        <span className="muted">{allocation.status}</span>
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
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as AllocationMode)}
          aria-label="Allocation mode"
        >
          <option value="fixed">fixed — exclusive partition</option>
          <option value="pooled">pooled — mirrors the pool</option>
        </select>

        {mode === 'fixed' ? (
          <input
            type="number"
            min={0}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-label="Partition size"
          />
        ) : (
          <input
            type="number"
            min={0}
            value={cap}
            placeholder="no cap"
            onChange={(e) => setCap(e.target.value)}
            aria-label="Maximum quantity, blank for uncapped"
          />
        )}

        <input
          type="number"
          step="0.01"
          min={0}
          value={price}
          placeholder="price"
          onChange={(e) => setPrice(e.target.value)}
          aria-label="Price"
        />

        <button type="submit" disabled={save.isPending || blocked}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onRemove}>
          Remove
        </button>
      </form>

      {preview.data && !blocked && (
        <p className="muted">
          Would list <strong>{preview.data.listed[allocation.channelInstanceId] ?? 0}</strong> ·
          pool becomes <strong>{preview.data.pool}</strong>
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

function AddAllocation({ ledger }: { ledger: Ledger }) {
  const save = useUpsertAllocation(ledger.inventoryItemId);
  const [channelInstanceId, setChannelInstanceId] = useState('');
  const [mode, setMode] = useState<AllocationMode>('pooled');

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!channelInstanceId.trim()) return;
        save.mutate(
          {
            channelInstanceId: channelInstanceId.trim(),
            mode,
            quantityAllocated: mode === 'fixed' ? 0 : null,
            maxQuantity: null,
          },
          { onSuccess: () => setChannelInstanceId('') },
        );
      }}
    >
      <input
        placeholder="Channel instance id"
        value={channelInstanceId}
        onChange={(e) => setChannelInstanceId(e.target.value)}
        aria-label="Channel instance id"
      />
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as AllocationMode)}
        aria-label="Mode for the new allocation"
      >
        <option value="pooled">pooled</option>
        <option value="fixed">fixed</option>
      </select>
      <button type="submit" disabled={save.isPending}>
        Add channel
      </button>
      {/* Channel management arrives in Phase 3; until then ids are entered by hand. */}
      <span className="muted">Channel configuration lands in Phase 3.</span>
    </form>
  );
}

export { formatPrice };
