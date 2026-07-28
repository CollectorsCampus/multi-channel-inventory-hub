import { useState } from 'react';
import {
  formatCell,
  useQueryConsoleStatus,
  useRunQuery,
  type QueryResult,
} from '../api/queryConsole';
import { ApiError } from '../api/client';

/**
 * Read-only SQL console (§7, admin-only).
 *
 * Deliberately plain. The temptation with a console is to build an IDE —
 * autocomplete, schema browser, saved queries — and every one of those is a
 * feature to maintain in aid of an escape hatch. A text area, a result table
 * and an honest error is the whole job.
 *
 * The page says out loud that it cannot write. An operator who does not know
 * that will try an UPDATE, get refused, and reasonably conclude the tool is
 * broken rather than that it is working.
 */
export function QueryConsolePage() {
  const status = useQueryConsoleStatus();
  const run = useRunQuery();

  const [sql, setSql] = useState('SELECT count(*) FROM inventory_items');
  const [result, setResult] = useState<QueryResult | null>(null);

  if (status.isLoading) {
    return (
      <section>
        <h1>Query console</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  if (!status.data?.enabled) {
    return (
      <section>
        <h1>Query console</h1>
        <div className="panel">
          <p className="muted">
            Not enabled on this deployment. Set <code>ENABLE_QUERY_CONSOLE=true</code> and point{' '}
            <code>QUERY_CONSOLE_DATABASE_URL</code> at a database role granted <code>SELECT</code>{' '}
            and nothing else. The application refuses to start if you enable it without that
            separate connection.
          </p>
        </div>
      </section>
    );
  }

  if (!status.data.available) {
    return (
      <section>
        <h1>Query console</h1>
        <div className="panel">
          <p className="error">{status.data.reason}</p>
        </div>
      </section>
    );
  }

  const submit = () => {
    setResult(null);
    run.mutate({ sql, maxRows: status.data.maxRows }, { onSuccess: setResult });
  };

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Query console</h1>
          <p className="muted">
            Read-only SQL against a restricted database role. Every statement runs inside a
            read-only transaction, so writes are refused by the database itself — changes go through
            the app, which is what keeps stock allocation consistent.
          </p>
        </div>
      </header>

      <div className="panel">
        <label htmlFor="sql">Statement</label>
        <textarea
          id="sql"
          className="sql-editor"
          rows={8}
          spellCheck={false}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter runs, because a console with only a mouse path is
            // a console nobody uses twice.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="inline-form">
          <button type="button" onClick={submit} disabled={run.isPending || sql.trim() === ''}>
            {run.isPending ? 'Running…' : 'Run'}
          </button>
          <span className="muted">Ctrl+Enter</span>
        </div>

        {run.isError && <QueryError error={run.error as Error} />}
      </div>

      {result && <ResultTable result={result} maxRows={status.data.maxRows} />}
    </section>
  );
}

function QueryError({ error }: { error: Error }) {
  const status = error instanceof ApiError ? error.status : undefined;

  return (
    <>
      <p className="error">{error.message}</p>
      {status === 403 && (
        <p className="muted">
          The console reads every table in the deployment, so it is restricted to administrators.
        </p>
      )}
    </>
  );
}

function ResultTable({ result, maxRows }: { result: QueryResult; maxRows: number }) {
  if (result.columns.length === 0) {
    return (
      <div className="panel">
        <p className="muted">No columns returned. {result.durationMs}ms.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <p className="muted">
        {result.rowCount} row{result.rowCount === 1 ? '' : 's'} in {result.durationMs}ms
        {result.truncated && (
          <>
            {' '}
            · <strong>showing the first {maxRows}</strong> — add a LIMIT or narrow the query to see
            the rest
          </>
        )}
      </p>

      {/* Scrolls in its own container: a wide result must not make the whole
          page scroll sideways. */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={index}>
                {result.columns.map((column) => (
                  <td key={column} className={row[column] === null ? 'muted' : undefined}>
                    {row[column] === null ? 'NULL' : formatCell(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.rows.length === 0 && <p className="muted">The query matched nothing.</p>}
    </div>
  );
}
