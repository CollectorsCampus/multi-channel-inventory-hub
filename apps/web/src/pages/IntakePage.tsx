import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  useCatalogSearch,
  useCatalogSources,
  useIntake,
  type CatalogCandidate,
} from '../api/catalog';
import { formatPrice } from '../api/inventory';
import { SKU_CONDITIONS } from '../constants';

/**
 * Intake: search the catalog, pick a printing, add stock (§7).
 *
 * Stock lands unallocated — where it goes is a separate decision, made in the
 * allocation editor.
 */
export function IntakePage() {
  const sources = useCatalogSources();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [game, setGame] = useState('');
  const [setName, setSetName] = useState('');
  const [selected, setSelected] = useState<CatalogCandidate | null>(null);

  // Catalog sources sit behind someone else's rate limits; do not query them
  // on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(text), 350);
    return () => clearTimeout(handle);
  }, [text]);

  const search = useCatalogSearch(debounced, game || undefined, setName || undefined);
  const games = [...new Set((sources.data ?? []).flatMap((s) => s.games))];

  return (
    <section>
      <header className="page-head">
        <div>
          <Link to="/" className="back">
            ← Inventory
          </Link>
          <h1>Add stock</h1>
          <p className="muted">Search the catalog, then add units. They land unallocated.</p>
        </div>
      </header>

      <div className="panel">
        <div className="filters">
          <input
            type="search"
            autoFocus
            placeholder="Search for a card…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search the catalog"
          />
          {games.length > 1 && (
            <select value={game} onChange={(e) => setGame(e.target.value)} aria-label="Game">
              <option value="">Any game</option>
              {games.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
          {/* Some sources cannot answer without a set. tcgcsv is static files
              with no search endpoint, so an unscoped query would mean
              downloading a whole category; it says so rather than returning a
              fraction of the matches. */}
          <input
            type="text"
            placeholder="Set (needed by some sources)"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            aria-label="Set"
          />
        </div>

        {sources.data?.length === 0 && (
          <p className="muted">No catalog sources are registered on this instance.</p>
        )}

        {text.trim().length > 0 && text.trim().length < 3 && <p className="muted">Keep typing…</p>}

        {search.isFetching && <p className="muted">Searching…</p>}

        {search.isError && <p className="error">{(search.error as Error).message}</p>}

        {/* A source being down must not hide the results that did come back. */}
        {search.data?.failures.map((failure) => (
          <p key={failure.sourceKey} className="error">
            {failure.sourceKey} is unavailable — results may be incomplete. ({failure.message})
          </p>
        ))}

        {search.data && search.data.candidates.length === 0 && !search.isFetching && (
          <p className="muted">Nothing matched.</p>
        )}

        <ul className="candidates">
          {search.data?.candidates.map((candidate) => (
            <li key={`${candidate.sourceKey}:${candidate.sourceId}`}>
              <button
                type="button"
                className={`candidate${selected?.sourceId === candidate.sourceId ? ' candidate-selected' : ''}`}
                onClick={() => setSelected(candidate)}
              >
                {candidate.imageUrl && (
                  <img src={candidate.imageUrl} alt="" width={44} height={61} loading="lazy" />
                )}
                <span className="candidate-body">
                  <span className="cell-title">{candidate.name}</span>
                  <span className="cell-sub">
                    {[candidate.setName, candidate.game].filter(Boolean).join(' · ')}
                  </span>
                  <span className="chips">
                    {Object.keys(candidate.externalIds).map((namespace) => (
                      <span key={namespace} className="chip">
                        {namespace}
                      </span>
                    ))}
                  </span>
                </span>
                {candidate.marketPrice !== undefined && (
                  <span className="muted">{formatPrice(candidate.marketPrice)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selected && <IntakeForm candidate={selected} onDone={() => setSelected(null)} />}
    </section>
  );
}

function IntakeForm({ candidate, onDone }: { candidate: CatalogCandidate; onDone: () => void }) {
  const intake = useIntake();
  const printings = candidate.printings ?? ['NORMAL'];

  const [condition, setCondition] = useState('NM');
  const [printing, setPrinting] = useState(printings[0] ?? 'NORMAL');
  const [quantity, setQuantity] = useState('1');
  const [cost, setCost] = useState('');

  useEffect(() => {
    setPrinting(candidate.printings?.[0] ?? 'NORMAL');
    setQuantity('1');
    setCost('');
    intake.reset();
    // Resetting when the operator picks a different card; the mutation object
    // itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate.sourceKey, candidate.sourceId]);

  const missingTcgplayer = !candidate.externalIds.tcgplayer;

  return (
    <div className="panel">
      <h2>Add {candidate.name}</h2>

      {/* ADR 0002: coverage is incomplete, and this matters later when matching
          a TCGPlayer listing back to this item. */}
      {missingTcgplayer && (
        <p className="muted">
          This printing has no TCGPlayer id in the catalog. It can still be tracked and sold;
          matching it to a TCGPlayer listing will need doing by hand.
        </p>
      )}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          intake.mutate(
            {
              sourceKey: candidate.sourceKey,
              sourceId: candidate.sourceId,
              condition,
              printing,
              language: candidate.language,
              quantity: Number(quantity) || 0,
              ...(cost === '' ? {} : { costBasis: Math.round(Number(cost) * 100) }),
            },
            { onSuccess: () => setQuantity('1') },
          );
        }}
      >
        <label htmlFor="condition">Condition</label>
        <select id="condition" value={condition} onChange={(e) => setCondition(e.target.value)}>
          {SKU_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label htmlFor="printing">Printing</label>
        <select id="printing" value={printing} onChange={(e) => setPrinting(e.target.value)}>
          {printings.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label htmlFor="quantity">Quantity</label>
        <input
          id="quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />

        <label htmlFor="cost">Unit cost</label>
        <input
          id="cost"
          type="number"
          step="0.01"
          min={0}
          placeholder="optional"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />

        <button type="submit" disabled={intake.isPending}>
          {intake.isPending ? 'Adding…' : 'Add to inventory'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Done
        </button>
      </form>

      {intake.isError && <p className="error">{(intake.error as Error).message}</p>}

      {intake.isSuccess && intake.data && (
        <p className="muted">
          Added. Now holding <strong>{intake.data.ledger.quantityOnHand}</strong>, all unallocated.{' '}
          <Link to="/items/$id" params={{ id: intake.data.ledger.inventoryItemId }}>
            Open item
          </Link>
        </p>
      )}
    </div>
  );
}
