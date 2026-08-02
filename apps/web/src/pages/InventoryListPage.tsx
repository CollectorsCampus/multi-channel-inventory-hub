import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  formatPrice,
  useCreateInventoryItem,
  useInventoryList,
  type InventoryRow,
} from '../api/inventory';
import { useChannels } from '../api/channels';
import { SKU_CONDITIONS } from '../constants';
import { NO_CHANNEL, PAGE_SIZES, type InventorySearch } from '../router';

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

function useShowImages(): [boolean, (next: boolean) => void] {
  const [showImages, setShowImages] = useState(() => {
    try {
      return localStorage.getItem(SHOW_IMAGES_KEY) === 'true';
    } catch {
      // Storage can be unavailable — private mode, a locked-down browser. The
      // preference is not worth failing a page render over.
      return false;
    }
  });

  return [
    showImages,
    (next: boolean) => {
      setShowImages(next);
      try {
        localStorage.setItem(SHOW_IMAGES_KEY, String(next));
      } catch {
        /* Preference is lost at reload, which is survivable. */
      }
    },
  ];
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
    { accessorKey: 'quantityOnHand', header: 'On hand' },
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
  const channels = useChannels();
  const pageSize = search.pageSize ?? 25;

  const query = useInventoryList({
    search: search.search,
    condition: search.condition,
    // One dropdown, two different questions for the API: a named channel is a
    // `some` filter, "none" is the opposite.
    ...(search.channel === NO_CHANNEL
      ? { unlisted: true }
      : search.channel
        ? { channelInstanceId: search.channel }
        : {}),
    page: search.page ?? 1,
    pageSize,
    sortBy: search.sortBy ?? 'name',
    sortDir: search.sortDir ?? 'asc',
  });

  const columns = useMemo(() => buildColumns(showImages), [showImages]);

  const table = useReactTable({
    data: query.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: query.data?.pageCount ?? 0,
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
        <select
          value={search.condition ?? ''}
          aria-label="Filter by condition"
          onChange={(e) =>
            void navigate({
              search: (prev) => ({ ...prev, condition: e.target.value || undefined, page: 1 }),
            })
          }
        >
          <option value="">Any condition</option>
          {SKU_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
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
                  {search.search || search.condition || search.channel
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
    </section>
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
