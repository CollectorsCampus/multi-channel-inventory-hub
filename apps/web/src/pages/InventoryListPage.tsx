import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  formatPrice,
  useApplyStockUpdates,
  useCreateInventoryItem,
  useInventoryGames,
  useInventoryList,
  useInventorySets,
  type InventoryRow,
  type StockUpdateResult,
} from '../api/inventory';
import { useChannels } from '../api/channels';
import { SKU_CONDITIONS } from '../constants';
import { NO_CHANNEL, NO_GAME, PAGE_SIZES, type InventorySearch } from '../router';

/**
 * The inventory browser (§7).
 *
 * Pagination, sorting and filtering are all server-side — the table never holds
 * more than one page, and its state lives in the URL so a filtered view can be
 * bookmarked and shared. TanStack Table is used purely for rendering here, with
 * `manual*` flags on, because the server owns the data shape.
 */

/**
 * Whether to show catalogue art, remembered across sessions.
 *
 * `localStorage` rather than the URL: it is a preference about how someone
 * likes to read the table, not part of what the table is showing, so it should
 * not travel when a filtered view is shared with a colleague.
 *
 * Off by default. A page of two hundred rows is two hundred remote images, and
 * that should be something a person turned on.
 */
const SHOW_IMAGES_KEY = 'hub.inventory.showImages';

/**
 * Whether to show only items physically held, remembered across sessions.
 *
 * This one changes *which rows* the table shows, so it lived in the URL for a
 * while — a shared link would then carry it. The operator asked for it to be
 * remembered instead, and for a single-operator tool a persistent default is
 * worth more than a shareable link: it is the view they want every time they
 * open the page. So it is a `localStorage` preference like "Show images", and
 * the trade is that a shared URL no longer carries this one filter.
 */
const IN_STOCK_KEY = 'hub.inventory.inStock';

function usePersistedFlag(key: string): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      // Storage can be unavailable — private mode, a locked-down browser. The
      // preference is not worth failing a page render over.
      return false;
    }
  });

  return [
    value,
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* Preference is lost at reload, which is survivable. */
      }
    },
  ];
}

const useShowImages = () => usePersistedFlag(SHOW_IMAGES_KEY);
const useInStockOnly = () => usePersistedFlag(IN_STOCK_KEY);

/** One on-hand edit awaiting confirmation. */
interface StagedChange {
  id: string;
  name: string;
  setName?: string;
  condition: string;
  from: number;
  to: number;
  /** Allocations on this item — each is a channel the new number gets pushed to. */
  channels: number;
}

/**
 * Passed to the On-hand cell through the table, so the whole table shares one
 * staged-edit map rather than every cell holding its own draft — which is what
 * lets several edits be applied together.
 */
interface InventoryTableMeta {
  staged: Record<string, string>;
  setStaged: (id: string, value: string) => void;
  requestApply: (ids: string[]) => void;
}

function buildColumns(showImages: boolean): ColumnDef<InventoryRow>[] {
  return [
    {
      accessorKey: 'name',
      header: 'Item',
      cell: ({ row }) => (
        <Link to="/items/$id" params={{ id: row.original.inventoryItemId }} className="cell-link">
          <span className="cell-item">
            {showImages && (
              <span className="thumb">
                {row.original.imageUrl && (
                  <img
                    src={row.original.imageUrl}
                    alt=""
                    // Decorative: the name is right next to it, so a screen
                    // reader announcing the filename would only be noise.
                    loading="lazy"
                  />
                )}
              </span>
            )}
            <span>
              <span className="cell-title">{row.original.name}</span>
              {row.original.setName && <span className="cell-sub">{row.original.setName}</span>}
            </span>
          </span>
        </Link>
      ),
    },
    { accessorKey: 'condition', header: 'Cond.' },
    {
      accessorKey: 'quantityOnHand',
      header: 'On hand',
      cell: ({ row, table }) => {
        const meta = table.options.meta as InventoryTableMeta;
        const id = row.original.inventoryItemId;
        const current = row.original.quantityOnHand;
        const raw = meta.staged[id];
        const value = raw ?? String(current);
        const parsed = Number(value);
        const valid = value !== '' && Number.isInteger(parsed) && parsed >= 0;
        const changed = raw !== undefined && valid && parsed !== current;
        const invalid = raw !== undefined && !valid;
        return (
          <input
            type="number"
            min={0}
            step={1}
            className={`qty-edit${changed ? ' qty-changed' : ''}${invalid ? ' qty-invalid' : ''}`}
            value={value}
            onChange={(e) => meta.setStaged(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                meta.requestApply([id]);
              }
            }}
            aria-label={`On hand for ${row.original.name}`}
          />
        );
      },
    },
    {
      accessorKey: 'reserveQuantity',
      header: 'Reserved',
      cell: ({ getValue }) => (getValue<number>() === 0 ? '—' : getValue<number>()),
    },
    {
      accessorKey: 'pool',
      header: 'Unallocated',
      cell: ({ getValue }) => <strong>{getValue<number>()}</strong>,
    },
    {
      id: 'channels',
      header: 'Channels',
      cell: ({ row }) => {
        const allocations = row.original.allocations;
        if (allocations.length === 0) return <span className="muted">Not listed</span>;
        return (
          <div className="chips">
            {allocations.map((a) => (
              <span key={a.id} className={`chip chip-${a.mode}`}>
                {a.mode === 'fixed' ? 'fixed' : 'pooled'} {a.desiredListedQuantity}
                {a.price !== null && <em> · {formatPrice(a.price, a.currency)}</em>}
              </span>
            ))}
          </div>
        );
      },
    },
  ];
}

export function InventoryListPage() {
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const [searchDraft, setSearchDraft] = useState(search.search ?? '');

  // Debounced so a round trip does not fire on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      if ((search.search ?? '') !== searchDraft) {
        void navigate({
          search: (prev) => ({ ...prev, search: searchDraft || undefined, page: 1 }),
        });
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [searchDraft, search.search, navigate]);

  const [showImages, setShowImages] = useShowImages();
  const [inStockOnly, setInStockOnly] = useInStockOnly();
  const channels = useChannels();
  const games = useInventoryGames();
  // Scoped to whichever game is chosen, and asked for only then — a set name
  // means nothing without one.
  const sets = useInventorySets(search.game === NO_GAME ? { noGame: true } : { game: search.game });
  const pageSize = search.pageSize ?? 25;

  const query = useInventoryList({
    search: search.search,
    ...(search.condition?.length ? { condition: search.condition } : {}),
    // Same shape as the channel filter below: a named game is an equality
    // filter, "none" is the opposite question.
    ...(search.game === NO_GAME ? { noGame: true } : search.game ? { game: search.game } : {}),
    ...(search.set ? { setName: search.set } : {}),
    // One dropdown, two different questions for the API: a named channel is a
    // `some` filter, "none" is the opposite.
    ...(search.channel === NO_CHANNEL
      ? { unlisted: true }
      : search.channel
        ? { channelInstanceId: search.channel }
        : {}),
    // Sent only when on: `inStock: false` would be a different query key and a
    // needless refetch for the same rows.
    ...(inStockOnly ? { inStock: true } : {}),
    page: search.page ?? 1,
    pageSize,
    sortBy: search.sortBy ?? 'name',
    sortDir: search.sortDir ?? 'asc',
  });

  const columns = useMemo(() => buildColumns(showImages), [showImages]);

  // -- On-hand editing -------------------------------------------------------
  // A draft value per item id, lifted here so several rows can be edited and
  // then applied together. Empty until someone types.
  const [staged, setStaged] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<StagedChange[] | null>(null);

  const items = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.inventoryItemId, item])),
    [items],
  );

  // The staged drafts that are a real, valid, different number — the only ones
  // worth confirming. A draft equal to the current count, or not a whole number
  // ≥ 0, is ignored rather than offered.
  const stagedChanges = useMemo<StagedChange[]>(() => {
    const out: StagedChange[] = [];
    for (const [id, raw] of Object.entries(staged)) {
      const item = itemById.get(id);
      if (!item) continue; // a row that has since scrolled off the page
      const parsed = Number(raw);
      if (raw === '' || !Number.isInteger(parsed) || parsed < 0 || parsed === item.quantityOnHand) {
        continue;
      }
      out.push({
        id,
        name: item.name,
        ...(item.setName ? { setName: item.setName } : {}),
        condition: item.condition,
        from: item.quantityOnHand,
        to: parsed,
        channels: item.allocations.length,
      });
    }
    return out;
  }, [staged, itemById]);

  const setStagedValue = useCallback((id: string, value: string) => {
    setStaged((prev) => ({ ...prev, [id]: value }));
  }, []);

  const requestApply = useCallback(
    (ids: string[]) => {
      const changes = stagedChanges.filter((change) => ids.includes(change.id));
      if (changes.length > 0) setConfirming(changes);
    },
    [stagedChanges],
  );

  // Drafts belong to the rows on screen. Changing the page, a filter or the sort
  // brings different rows up, so any unapplied drafts are dropped — applying a
  // number typed against a row you can no longer see would be a nasty surprise.
  const searchKey = JSON.stringify(search);
  useEffect(() => {
    setStaged({});
  }, [searchKey, inStockOnly]);

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: query.data?.pageCount ?? 0,
    meta: {
      staged,
      setStaged: setStagedValue,
      requestApply,
    } satisfies InventoryTableMeta,
  });

  const page = search.page ?? 1;
  const pageCount = query.data?.pageCount ?? 0;

  function toggleSort(field: 'name' | 'quantityOnHand' | 'condition') {
    void navigate({
      search: (prev: InventorySearch): InventorySearch => ({
        ...prev,
        sortBy: field,
        sortDir: prev.sortBy === field && prev.sortDir === 'asc' ? 'desc' : 'asc',
        page: 1,
      }),
    });
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Inventory</h1>
          <p className="muted">
            {query.data ? `${query.data.total} item${query.data.total === 1 ? '' : 's'}` : ' '}
          </p>
        </div>
        <NewItemForm />
      </header>

      <div className="filters">
        <input
          type="search"
          placeholder="Search by name…"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          aria-label="Search inventory by name"
        />
        {/* Toggle chips rather than a `<select multiple>`, which needs a
            modifier key nobody discovers and shows its selection badly at this
            size. Seven short tokens fit the filter row, and each is one click.
            No "Any" chip: none selected already means every condition, and a
            chip that has to be deselected to widen the filter reads backwards. */}
        <span className="chips filter-chips" role="group" aria-label="Filter by condition">
          {SKU_CONDITIONS.map((c) => {
            const on = (search.condition ?? []).includes(c);
            return (
              <button
                key={c}
                type="button"
                className={`chip chip-toggle${on ? ' chip-on' : ''}`}
                aria-pressed={on}
                onClick={() =>
                  void navigate({
                    // Typed explicitly: this is the first handler here that
                    // *reads* a previous value rather than only spreading, and
                    // the router types `prev` as possibly empty.
                    search: (prev: InventorySearch) => {
                      const current = prev.condition ?? [];
                      const next = on ? current.filter((v: string) => v !== c) : [...current, c];
                      return { ...prev, condition: next.length > 0 ? next : undefined, page: 1 };
                    },
                  })
                }
              >
                {c}
              </button>
            );
          })}
        </span>

        {/* Games the ledger actually holds, so no option can return nothing.
            The null bucket is offered only when something is in it — a store
            with no supplies or accessories should not be shown a filter for
            them. */}
        <select
          value={search.game ?? ''}
          aria-label="Filter by game"
          onChange={(e) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                game: e.target.value || undefined,
                // Cleared with the game, always. A set belongs to exactly one
                // game, so one carried across would match nothing — and a
                // filter that silently empties the table reads as a broken
                // page rather than as a filter doing its job.
                set: undefined,
                page: 1,
              }),
            })
          }
        >
          <option value="">Any game</option>
          {(games.data ?? []).map((g) => (
            <option key={g.game ?? NO_GAME} value={g.game ?? NO_GAME}>
              {g.game ?? 'No game'} ({g.items})
            </option>
          ))}
        </select>

        {/* Present but disabled rather than hidden, so the filter is
            discoverable before it is usable and the row does not reflow when a
            game is picked. Its own sets carry counts for the same reason the
            games do: an option that returns nothing is worse than no option. */}
        <select
          value={search.set ?? ''}
          disabled={!search.game || (sets.data?.length ?? 0) === 0}
          aria-label="Filter by set"
          title={search.game ? undefined : 'Pick a game first'}
          onChange={(e) =>
            void navigate({
              search: (prev) => ({ ...prev, set: e.target.value || undefined, page: 1 }),
            })
          }
        >
          <option value="">
            {!search.game
              ? 'Any set — pick a game'
              : sets.isLoading
                ? 'Loading sets…'
                : (sets.data?.length ?? 0) === 0
                  ? 'No sets recorded'
                  : 'Any set'}
          </option>
          {(sets.data ?? []).map((s) => (
            <option key={s.setName} value={s.setName}>
              {s.setName} ({s.items})
            </option>
          ))}
        </select>

        <select
          value={search.channel ?? ''}
          aria-label="Filter by channel"
          onChange={(e) =>
            void navigate({
              search: (prev) => ({ ...prev, channel: e.target.value || undefined, page: 1 }),
            })
          }
        >
          <option value="">Any channel</option>
          <option value={NO_CHANNEL}>On no channel</option>
          {/* The connector is named too, because nothing stops two channels
              sharing a display name — and this operator's Shopify and
              TCGPlayer channels are both called "Collector's Campus", which
              made the two options indistinguishable. */}
          {(channels.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} · {c.connectorKey}
            </option>
          ))}
        </select>

        <select
          value={pageSize}
          aria-label="Rows per page"
          onChange={(e) =>
            void navigate({
              // Back to page 1: page 7 of a 25-row view is off the end of a
              // 200-row one, and an empty table would look like a broken filter.
              search: (prev) => ({ ...prev, pageSize: Number(e.target.value), page: 1 }),
            })
          }
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </select>

        {/* A remembered preference now (see useInStockOnly). It still resets to
            page 1 on change, because filtering 400 rows down to 30 leaves page 6
            off the end, and an empty table reads as a broken filter. */}
        <label className="inline-check">
          <input
            type="checkbox"
            checked={inStockOnly}
            onChange={(e) => {
              setInStockOnly(e.target.checked);
              void navigate({ search: (prev) => ({ ...prev, page: 1 }) });
            }}
          />
          In stock only
        </label>

        <label className="inline-check">
          <input
            type="checkbox"
            checked={showImages}
            onChange={(e) => setShowImages(e.target.checked)}
          />
          Show images
        </label>
      </div>

      {query.isError && <p className="error">{(query.error as Error).message}</p>}

      {stagedChanges.length > 0 && (
        <div className="staged-bar">
          <span>
            {stagedChanges.length} row{stagedChanges.length === 1 ? '' : 's'} changed
          </span>
          <button type="button" onClick={() => setConfirming(stagedChanges)}>
            Review &amp; apply
          </button>
          <button type="button" className="ghost" onClick={() => setStaged({})}>
            Discard
          </button>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const id = header.column.id;
                  const sortable = id === 'name' || id === 'quantityOnHand' || id === 'condition';
                  const active = (search.sortBy ?? 'name') === id;
                  return (
                    <th key={header.id}>
                      {sortable ? (
                        <button
                          type="button"
                          className="sort"
                          onClick={() => toggleSort(id as 'name')}
                          aria-sort={
                            active
                              ? (search.sortDir ?? 'asc') === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {active && (
                            <span aria-hidden>
                              {(search.sortDir ?? 'asc') === 'asc' ? ' ↑' : ' ↓'}
                            </span>
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
            {!query.isLoading && table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  {search.search || search.condition?.length || search.channel
                    ? 'No items match those filters.'
                    : 'No inventory yet. Add your first item above.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <nav className="pager" aria-label="Pagination">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => void navigate({ search: (p) => ({ ...p, page: page - 1 }) })}
          >
            Previous
          </button>
          <span className="muted">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => void navigate({ search: (p) => ({ ...p, page: page + 1 }) })}
          >
            Next
          </button>
        </nav>
      )}

      {confirming && (
        <ConfirmStockUpdates
          changes={confirming}
          onClose={(appliedOkIds) => {
            if (appliedOkIds.length > 0) {
              setStaged((prev) => {
                const next = { ...prev };
                for (const id of appliedOkIds) delete next[id];
                return next;
              });
            }
            setConfirming(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Confirm one or several on-hand changes before they touch the ledger.
 *
 * A deliberate stop, because setting on-hand here is not just bookkeeping: for
 * an item listed on a channel the new number is pushed to that channel, so an
 * inventory edit can change what a customer sees. The dialog names every change
 * and flags the ones that push. After applying it shows the outcome — the batch
 * is fault-tolerant, so a row that fails is reported while the rest still land.
 */
function ConfirmStockUpdates({
  changes,
  onClose,
}: {
  changes: StagedChange[];
  onClose: (appliedOkIds: string[]) => void;
}) {
  const apply = useApplyStockUpdates();
  const [results, setResults] = useState<StockUpdateResult[] | null>(null);

  const okIds = results ? results.filter((r) => r.ok).map((r) => r.id) : [];
  const failed = results ? results.filter((r) => !r.ok) : [];
  const pushes = changes.filter((c) => c.channels > 0).length;
  const byId = new Map(changes.map((c) => [c.id, c]));

  return (
    <div className="modal-overlay" onClick={() => !apply.isPending && onClose(okIds)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm stock update"
        onClick={(e) => e.stopPropagation()}
      >
        {results === null ? (
          <>
            <h2>{changes.length === 1 ? 'Update stock' : `Update ${changes.length} items`}</h2>
            <table className="compact">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">On hand</th>
                  <th>Channel</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="cell-title">{c.name}</span>
                      <span className="cell-sub">
                        {[c.setName, c.condition].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className="num">
                      {c.from} → <strong>{c.to}</strong>
                    </td>
                    <td>
                      {c.channels > 0 ? (
                        <span className="chip">
                          pushes to {c.channels} channel{c.channels === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pushes > 0 && (
              <p className="field-hint">
                {pushes} of these {pushes === 1 ? 'is' : 'are'} listed on a channel — the new
                quantity will be pushed there, changing what buyers see.
              </p>
            )}
            {apply.isError && <p className="error">{(apply.error as Error).message}</p>}
            <div className="inline-form">
              <button
                type="button"
                disabled={apply.isPending}
                onClick={() =>
                  apply.mutate(
                    {
                      updates: changes.map((c) => ({ id: c.id, quantityOnHand: c.to })),
                      note: 'Set from inventory table',
                    },
                    { onSuccess: setResults },
                  )
                }
              >
                {apply.isPending
                  ? 'Applying…'
                  : `Apply ${changes.length === 1 ? '' : `${changes.length} `}change${changes.length === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={apply.isPending}
                onClick={() => onClose([])}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Done</h2>
            <p className="muted">
              {okIds.length} applied{failed.length > 0 ? `, ${failed.length} failed` : ''}.
            </p>
            {failed.map((f) => (
              <p key={f.id} className="error">
                {byId.get(f.id)?.name ?? f.id}: {f.error}
              </p>
            ))}
            <div className="inline-form">
              <button type="button" onClick={() => onClose(okIds)}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NewItemForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [condition, setCondition] = useState('NM');
  const [quantity, setQuantity] = useState('1');
  const create = useCreateInventoryItem();

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Add item
      </button>
    );
  }

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          { name: name.trim(), condition, quantityOnHand: Number(quantity) || 0 },
          {
            onSuccess: () => {
              setName('');
              setQuantity('1');
              setOpen(false);
            },
          },
        );
      }}
    >
      <input
        required
        placeholder="Item name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Item name"
      />
      <select
        value={condition}
        onChange={(e) => setCondition(e.target.value)}
        aria-label="Condition"
      >
        {SKU_CONDITIONS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        aria-label="Quantity on hand"
      />
      <button type="submit" disabled={create.isPending}>
        {create.isPending ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {create.isError && <p className="error">{(create.error as Error).message}</p>}
    </form>
  );
}
