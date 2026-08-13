import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAlertAction, useAlerts, useSyncEvents, type Alert, type SyncEvent } from '../api/sync';
import { displayListingTitle, useListingUrl } from '../api/listings';

/**
 * A channel's name, linking to its card on the Channels page.
 *
 * The id rides as the hash so the page can scroll to the card once its data
 * loads. A name with no id (the channel has since been deleted) stays plain
 * text — a link to a card that no longer exists would 404 the reader's trust,
 * not the browser.
 */
function ChannelRef({ id, name }: { id: string | null; name: string }) {
  if (!id) return <code>{name}</code>;
  return (
    <Link to="/channels" hash={id}>
      <code>{name}</code>
    </Link>
  );
}

/**
 * Sync activity and the conflict inbox (§7).
 *
 * Two panels because they answer different questions. The inbox is "what needs
 * me?" — a short list an operator is expected to empty. The log is "what
 * happened?" — long, mostly boring, and consulted when something looks wrong.
 * Merging them would bury an oversell under a thousand routine pushes.
 */
export function ActivityPage() {
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Sync activity</h1>
          <p className="muted">What the hub has told the channels, and what they told it.</p>
        </div>
      </header>

      <AlertInbox />
      <EventLog />
    </section>
  );
}

function AlertInbox() {
  const [status, setStatus] = useState('open');
  const alerts = useAlerts({ status: status || undefined });
  const act = useAlertAction();

  return (
    <div className="panel">
      <div className="channel-head">
        <h2>Alerts</h2>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Alert status"
        >
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </select>
      </div>

      {alerts.isError && <p className="error">{(alerts.error as Error).message}</p>}

      {alerts.data?.items.length === 0 && (
        <p className="muted">
          {status === 'open' ? 'Nothing needs attention.' : 'No alerts in this state.'}
        </p>
      )}

      {alerts.data?.items.map((alert) => (
        <AlertRow
          key={alert.id}
          alert={alert}
          busy={act.isPending}
          onAction={(action) => act.mutate({ id: alert.id, action })}
        />
      ))}

      {act.isError && <p className="error">{(act.error as Error).message}</p>}
    </div>
  );
}

function AlertRow({
  alert,
  busy,
  onAction,
}: {
  alert: Alert;
  busy: boolean;
  onAction: (action: 'acknowledge' | 'resolve' | 'reopen') => void;
}) {
  return (
    <div className="allocation">
      <div className="allocation-head">
        <span className={`chip severity-${alert.severity}`}>{alert.severity}</span>
        <strong>{alert.title}</strong>
        <span className="muted">{alert.kind.replace(/_/g, ' ')}</span>
        {alert.channelName && <ChannelRef id={alert.channelInstanceId} name={alert.channelName} />}
        <span className="muted">{new Date(alert.createdAt).toLocaleString()}</span>
      </div>

      {alert.detail && <p className="muted">{alert.detail}</p>}

      <AlertListingLink alert={alert} />

      {alert.acknowledgedBy && alert.status !== 'open' && (
        <p className="field-hint">
          {alert.status === 'resolved' ? 'Resolved' : 'Acknowledged'} by {alert.acknowledgedBy}
        </p>
      )}

      <div className="inline-form">
        {alert.status === 'open' && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => onAction('acknowledge')}
          >
            I&apos;m on it
          </button>
        )}
        {alert.status !== 'resolved' ? (
          <button type="button" disabled={busy} onClick={() => onAction('resolve')}>
            Resolve
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => onAction('reopen')}
          >
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Where the listing an alert is about lives, resolved from the channel itself.
 *
 * The inbound worker's unmapped-listing flag records the platform id of the
 * listing that sold (`latestExternalListingId`), which names nothing a human
 * can open. The channel can turn it into its admin page — the same
 * `listing.url` read the item-detail screen uses. A channel that cannot
 * answer (no `listing.url`, listing deleted, no channel at all) shows nothing
 * rather than an error: the link is a convenience beside the alert, not data
 * the inbox depends on.
 */
function AlertListingLink({ alert }: { alert: Alert }) {
  const context = (alert.context ?? {}) as { latestExternalListingId?: unknown };
  const externalListingId =
    typeof context.latestExternalListingId === 'string' ? context.latestExternalListingId : null;

  const link = useListingUrl(
    alert.channelInstanceId ?? '',
    externalListingId,
    externalListingId !== null && alert.channelInstanceId !== null,
  );

  if (externalListingId === null) return null;

  // With a title the admin link *is* the item's name, which answers the
  // question the alert raises — "what actually sold?" — in the row itself.
  const adminLabel = link.data?.title ? displayListingTitle(link.data.title) : 'Shopify admin';

  return (
    <p className="field-hint">
      {link.data?.adminUrl && (
        <a href={link.data.adminUrl} target="_blank" rel="noreferrer">
          {adminLabel} ↗{' '}
        </a>
      )}
      {link.data?.url && (
        <a href={link.data.url} target="_blank" rel="noreferrer">
          View on store ↗{' '}
        </a>
      )}
      {/* The remediation itself, one click away: the manual-link panel opens
          with this listing's id already filled in. */}
      <Link to="/match" search={{ listing: externalListingId }}>
        Link to inventory →
      </Link>
    </p>
  );
}

function EventLog() {
  const [direction, setDirection] = useState('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);

  const events = useSyncEvents({
    direction: direction || undefined,
    outcome: outcome || undefined,
    page,
  });

  return (
    <div className="panel">
      <div className="channel-head">
        <h2>Log</h2>
        <div className="filters">
          <select
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value);
              setPage(1);
            }}
            aria-label="Direction"
          >
            <option value="">Any direction</option>
            <option value="outbound">Outbound</option>
            <option value="inbound">Inbound</option>
            <option value="reconcile">Reconcile</option>
          </select>
          <select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
            aria-label="Outcome"
          >
            <option value="">Any outcome</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
            <option value="conflict">Conflict</option>
            <option value="pending">Pending</option>
          </select>
        </div>
      </div>

      {events.isError && <p className="error">{(events.error as Error).message}</p>}

      {events.data?.items.length === 0 && <p className="muted">Nothing logged yet.</p>}

      {events.data && events.data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Direction</th>
                <th>Operation</th>
                <th>Channel</th>
                <th>Outcome</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(events.data?.pageCount ?? 0) > 1 && (
        <nav className="pager" aria-label="Log pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page} of {events.data?.pageCount} · {events.data?.total} events
          </span>
          <button
            type="button"
            disabled={page >= (events.data?.pageCount ?? 1)}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

function EventRow({ event }: { event: SyncEvent }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr>
        <td>{new Date(event.ts).toLocaleTimeString()}</td>
        <td>{event.direction}</td>
        <td>{event.operation ?? event.entityType}</td>
        <td>
          {event.channelName ? (
            <ChannelRef id={event.channelInstanceId} name={event.channelName} />
          ) : (
            '—'
          )}
        </td>
        <td>
          <span className={`chip outcome-${event.outcome}`}>{event.outcome}</span>
        </td>
        <td className="detail-cell">
          {event.detail ?? (event.durationMs !== null ? `${event.durationMs} ms` : '—')}
          {event.payload !== null && (
            <button type="button" className="linkish" onClick={() => setOpen(!open)}>
              {open ? 'hide' : 'payload'}
            </button>
          )}
        </td>
      </tr>
      {open && event.payload !== null && (
        <tr>
          {/* The raw record of what crossed the boundary — the point of an
              audit log is that it is inspectable, not summarised. */}
          <td colSpan={6}>
            <pre className="payload">{JSON.stringify(event.payload, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
