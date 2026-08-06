import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  DEFAULT_MAX_SETS,
  useCatalogCredentialStatus,
  useCatalogSources,
  useIngestableSets,
  useLocalSearch,
  useLocalSets,
  useRunIngest,
  useSetCatalogCredentials,
  type LocalSetSummary,
} from '../api/catalog';
import { useCurrentUser } from '../auth';
import { SecretFields } from '../components/SchemaForm';

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

  /**
   * Sets grouped under their game.
   *
   * A flat list was fine at 48 sets and stops being fine well before a full
   * game is ingested — Magic alone is 453. Grouping keeps the page a summary by
   * default, which is the question this panel usually answers ("do I hold any
   * Lorcana?") rather than the one a flat table answers ("what is set 312?").
   */
  const byGame = useMemo(() => {
    const map = new Map<string, { sets: LocalSetSummary[]; items: number }>();
    for (const set of localSets.data ?? []) {
      const key = set.game ?? '(no game)';
      const entry = map.get(key) ?? { sets: [], items: 0 };
      entry.sets.push(set);
      entry.items += set.items;
      map.set(key, entry);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [localSets.data]);

  const totalItems = byGame.reduce((sum, [, g]) => sum + g.items, 0);

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
              {localSets.data.length} set(s), {totalItems} item(s), across {byGame.length} game(s).
            </p>
            {byGame.map(([game, entry]) => (
              // Expanded when it is the only game, because a disclosure hiding
              // the single thing on the page is just an extra click.
              <details key={game} className="quiet-details" open={byGame.length === 1}>
                <summary>
                  {game === '(no game)' ? 'No game' : game}
                  <span className="muted">
                    {' '}
                    · {entry.sets.length} set(s), {entry.items} item(s)
                  </span>
                </summary>
                <table className="compact">
                  <thead>
                    <tr>
                      <th>Set</th>
                      <th className="num">Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.sets.map((set) => (
                      <tr key={`${set.game ?? ''}:${set.setName}`}>
                        <td>
                          {/* Set names are case-sensitive downstream, so browsing
                              by click uses the stored spelling, never a typed one. */}
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
              </details>
            ))}
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

  const selectedSource = sources.data?.find((s) => s.key === sourceKey);
  const needsCredentials = (selectedSource?.secretFields.length ?? 0) > 0;

  const [credentialInputs, setCredentialInputs] = useState<Record<string, string>>({});
  // A typed-but-unsaved token for one source has no business surviving a
  // switch to another — that would look like it applied to the new one.
  useEffect(() => setCredentialInputs({}), [sourceKey]);

  const credentialStatus = useCatalogCredentialStatus(sourceKey, needsCredentials);
  const setCredentials = useSetCatalogCredentials(sourceKey);
  const configured =
    credentialStatus.data !== undefined &&
    credentialStatus.data.secretFieldsRequired.every((f) =>
      credentialStatus.data!.secretsSet.includes(f),
    );

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
          disabled={available.isFetching || sourceKey === '' || (needsCredentials && !configured)}
          onClick={() => setListRequested(true)}
        >
          {available.isFetching ? 'Listing…' : 'List sets'}
        </button>
      </div>

      {/*
        A source declaring secretFields (CardTrader today) needs a token
        before it can answer anything. Shown right under the picker so setting
        it is the obvious next step rather than a buried settings screen —
        the same reasoning that put listing defaults on the channel itself.
      */}
      {needsCredentials && selectedSource && (
        <div>
          <p className="muted">
            {configured
              ? `${selectedSource.displayName} is configured.`
              : `${selectedSource.displayName} needs a token before it can be searched or ingested.`}
          </p>
          <SecretFields
            fields={selectedSource.secretFields}
            alreadySet={credentialStatus.data?.secretsSet ?? []}
            value={credentialInputs}
            onChange={setCredentialInputs}
            idPrefix={`catalog-${sourceKey}`}
          />
          <div className="inline-form">
            <button
              type="button"
              disabled={Object.keys(credentialInputs).length === 0 || setCredentials.isPending}
              onClick={() =>
                setCredentials.mutate(credentialInputs, {
                  onSuccess: () => setCredentialInputs({}),
                })
              }
            >
              {setCredentials.isPending ? 'Saving…' : 'Save credentials'}
            </button>
          </div>
          {setCredentials.isError && (
            <p className="error">{(setCredentials.error as Error).message}</p>
          )}
        </div>
      )}

      {available.isError && <p className="error">{(available.error as Error).message}</p>}

      {available.data && (
        <>
          <p className="muted">
            {available.data.length} set(s) available. Pick the ones to ingest — an unselected run is
            refused server-side rather than ingesting everything.
          </p>
          <div className="inline-form">
            <button
              type="button"
              onClick={() => setSelected(new Set(sorted.map((s) => s.setId)))}
              disabled={selected.size === sorted.length}
            >
              Select all {sorted.length}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Clear
            </button>
            {selected.size > 0 && <span className="muted">{selected.size} selected</span>}
          </div>
          {/*
            The server's own guard is a *default* of 50, and it refuses rather
            than truncating — so a deliberate 217-set run would otherwise be
            rejected for being what the operator asked for. Raising the ceiling
            to the selection is honest because the request names every set
            explicitly: nothing can be silently left out. The cost is real
            though, so it is stated rather than discovered.
          */}
          {selected.size > DEFAULT_MAX_SETS && (
            <p className="field-hint">
              That is {selected.size} sets, so this run makes {selected.size} requests to the source
              and will take a while. Sources are community infrastructure — worth doing once rather
              than repeatedly.
            </p>
          )}
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
                ...(selected.size > DEFAULT_MAX_SETS ? { maxSets: selected.size } : {}),
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
