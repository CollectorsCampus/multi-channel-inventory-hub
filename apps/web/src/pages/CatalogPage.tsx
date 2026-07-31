import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  useCatalogSources,
  useIngestableSets,
  useLocalSearch,
  useLocalSets,
  useRunIngest,
} from '../api/catalog';
import { useCurrentUser } from '../auth';

/**
 * The local catalog: what has been ingested, browsable without a set name and
 * searchable with no network. Matching and match-confirmation read this first,
 * so "is the set in here?" is a question an operator needs answered before a
 * proposal run — and this page is the answer.
 *
 * Ingest lives on the same page because the two halves explain each other: the
 * sets list shows what a run covered, and a gap in it shows what the next run
 * should name.
 */
export function CatalogPage() {
  const { data: user } = useCurrentUser();
  const localSets = useLocalSets();

  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [setName, setSetName] = useState('');

  // Our own database, but no reason to query it letter by letter.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(handle);
  }, [text]);

  const search = useLocalSearch(debounced, undefined, setName || undefined);

  const games = useMemo(() => {
    const byGame = new Map<string, { sets: number; items: number }>();
    for (const set of localSets.data ?? []) {
      const key = set.game ?? '(no game)';
      const entry = byGame.get(key) ?? { sets: 0, items: 0 };
      entry.sets += 1;
      entry.items += set.items;
      byGame.set(key, entry);
    }
    return byGame;
  }, [localSets.data]);

  const totalItems = [...games.values()].reduce((sum, g) => sum + g.items, 0);

  return (
    <section>
      <header className="page-head">
        <div>
          <Link to="/" className="back">
            ← Inventory
          </Link>
          <h1>Catalog</h1>
          <p className="muted">
            The local card catalogue — what has been ingested from the sources. Matching draws its
            candidates from here first, with no network involved.
          </p>
        </div>
      </header>

      <div className="panel">
        <h2>Search what is held</h2>
        <div className="filters">
          <input
            type="search"
            placeholder="Search the local catalog…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search the local catalog"
          />
          <input
            type="text"
            placeholder="Set (or pick one below)"
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            aria-label="Set"
          />
          {setName && (
            <button type="button" className="ghost" onClick={() => setSetName('')}>
              Clear set
            </button>
          )}
        </div>

        {search.isFetching && <p className="muted">Searching…</p>}
        {search.isError && <p className="error">{(search.error as Error).message}</p>}
        {search.data && search.data.candidates.length === 0 && !search.isFetching && (
          <p className="muted">Nothing in the local catalog matched.</p>
        )}

        <ul className="candidates">
          {search.data?.candidates.map((candidate) => (
            <li key={`${candidate.sourceKey}:${candidate.sourceId}`}>
              <div className="candidate">
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
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel">
        <h2>Sets held</h2>
        {localSets.isError && <p className="error">{(localSets.error as Error).message}</p>}
        {localSets.data && localSets.data.length === 0 && (
          <p className="muted">
            The local catalog is empty. Run an ingest below to fill it from a source.
          </p>
        )}
        {localSets.data && localSets.data.length > 0 && (
          <>
            <p className="muted">
              {localSets.data.length} set(s), {totalItems} item(s), across{' '}
              {[...games.keys()].filter((g) => g !== '(no game)').join(', ')}.
            </p>
            <table className="compact">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Set</th>
                  <th className="num">Items</th>
                </tr>
              </thead>
              <tbody>
                {localSets.data.map((set) => (
                  <tr key={`${set.game ?? ''}:${set.setName}`}>
                    <td>{set.game ?? '—'}</td>
                    <td>
                      {/* Set names are case-sensitive downstream, so browsing by
                          click uses the stored spelling rather than a typed one. */}
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          setSetName(set.setName);
                          setText('');
                        }}
                      >
                        {set.setName}
                      </button>
                    </td>
                    <td className="num">{set.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Server enforces admin-only; the panel explains rather than hides (§8). */}
      {user?.role === 'admin' ? (
        <IngestPanel />
      ) : (
        <div className="panel">
          <h2>Ingest</h2>
          <p className="muted">Running an ingest needs the admin role.</p>
        </div>
      )}
    </section>
  );
}

function IngestPanel() {
  const sources = useCatalogSources();
  const [sourceKey, setSourceKey] = useState('');
  const [game, setGame] = useState('');
  const [listRequested, setListRequested] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Default to the first source that can actually ingest — offering one that
  // cannot would make the panel's only possible answer an error.
  useEffect(() => {
    const first = sources.data?.find((s) => s.canIngest);
    if (!sourceKey && first) setSourceKey(first.key);
  }, [sourceKey, sources.data]);

  const available = useIngestableSets(sourceKey, game, listRequested && sourceKey !== '');
  const run = useRunIngest();

  // A different source or game lists different sets; stale selections would
  // silently ingest the wrong thing.
  useEffect(() => {
    setSelected(new Set());
    setListRequested(false);
  }, [sourceKey, game]);

  const toggle = (setId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(setId)) next.delete(setId);
      else next.add(setId);
      return next;
    });
  };

  const sorted = useMemo(() => {
    // Newest first: the set an operator wants is almost always a recent one.
    return [...(available.data ?? [])].sort((a, b) =>
      (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''),
    );
  }, [available.data]);

  return (
    <div className="panel">
      <h2>Ingest from a source</h2>
      <p className="muted">
        Reads whole sets from a source into the local catalog. Identity only — no prices are stored,
        and no stock moves. Re-running a set refreshes names and images and is safe.
      </p>

      <div className="filters">
        <select
          value={sourceKey}
          onChange={(e) => setSourceKey(e.target.value)}
          aria-label="Catalog source"
        >
          {(sources.data ?? []).map((source) => (
            <option key={source.key} value={source.key} disabled={!source.canIngest}>
              {source.displayName}
              {source.canIngest ? '' : ' — cannot be ingested'}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Game (e.g. Pokemon)"
          value={game}
          onChange={(e) => setGame(e.target.value)}
          aria-label="Game"
        />
        <button
          type="button"
          disabled={available.isFetching || sourceKey === ''}
          onClick={() => setListRequested(true)}
        >
          {available.isFetching ? 'Listing…' : 'List sets'}
        </button>
      </div>

      {available.isError && <p className="error">{(available.error as Error).message}</p>}

      {available.data && (
        <>
          <p className="muted">
            {available.data.length} set(s) available. Pick the ones to ingest — an unselected run is
            refused server-side rather than ingesting everything.
          </p>
          <div className="ingest-sets">
            {sorted.map((set) => (
              <label key={set.setId} className="inline-check">
                <input
                  type="checkbox"
                  checked={selected.has(set.setId)}
                  onChange={() => toggle(set.setId)}
                />
                <span>
                  {set.name}
                  {set.releasedAt && (
                    <span className="muted"> · {set.releasedAt.slice(0, 10)}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={selected.size === 0 || run.isPending}
            onClick={() =>
              run.mutate({
                sourceKey,
                ...(game ? { game } : {}),
                setIds: [...selected],
              })
            }
          >
            {run.isPending ? 'Ingesting…' : `Ingest ${selected.size} set(s)`}
          </button>
        </>
      )}

      {run.isError && <p className="error">{(run.error as Error).message}</p>}

      {run.isSuccess && run.data && (
        <div>
          <p className="muted">
            Read {run.data.sets} set(s), {run.data.products} product(s):{' '}
            <strong>{run.data.created} created</strong>, {run.data.refreshed} refreshed,{' '}
            {run.data.unchanged} unchanged, in {(run.data.durationMs / 1000).toFixed(1)}s.
          </p>
          {run.data.problems.map((problem) => (
            <p key={problem.set} className="error">
              {problem.set}: {problem.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
