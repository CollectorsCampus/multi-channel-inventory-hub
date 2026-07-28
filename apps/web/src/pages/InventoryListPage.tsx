import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  formatPrice,
  useCreateInventoryItem,
  useInventoryList,
  type InventoryRow,
} from '../api/inventory';
import { SKU_CONDITIONS } from '../constants';
import type { InventorySearch } from '../router';

/**
 * The inventory browser (§7).
 *
 * Pagination, sorting and filtering are all server-side — the table never holds
 * more than one page, and its state lives in the URL so a filtered view can be
 * bookmarked and shared. TanStack Table is used purely for rendering here, with
 * `manual*` flags on, because the server owns the data shape.
 */

const columns: ColumnDef<InventoryRow>[] = [
  {
    accessorKey: 'name',
    header: 'Item',
    cell: ({ row }) => (
      <Link to="/items/$id" params={{ id: row.original.inventoryItemId }} className="cell-link">
        <span className="cell-title">{row.original.name}</span>
        {row.original.setName && <span className="cell-sub">{row.original.setName}</span>}
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

  const query = useInventoryList({
    search: search.search,
    condition: search.condition,
    page: search.page ?? 1,
    pageSize: search.pageSize ?? 25,
    sortBy: search.sortBy ?? 'name',
    sortDir: search.sortDir ?? 'asc',
  });

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
                  {search.search || search.condition
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
