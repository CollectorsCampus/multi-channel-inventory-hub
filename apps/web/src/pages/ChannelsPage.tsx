import { useRef, useState } from 'react';
import {
  describeSyncMode,
  useChannels,
  useConnectors,
  useCreateChannel,
  useDeleteChannel,
  useExportChannel,
  useImportChannelFile,
  useUpdateChannel,
  type Channel,
  type ConnectorSummary,
  type ImportKind,
  type ImportSummary,
} from '../api/channels';
import { SchemaForm, SecretFields } from '../components/SchemaForm';
import { ApiError } from '../api/client';

/**
 * Channel configuration (§7).
 *
 * Admin-only on the server; this page simply reflects that. Every settings form
 * here is generated from the connector's own JSON Schema — nothing about
 * Shopify is hard-coded, which is what lets a community connector arrive with a
 * working settings UI.
 */
export function ChannelsPage() {
  const channels = useChannels();
  const connectors = useConnectors();
  const [adding, setAdding] = useState(false);

  if (channels.isError) {
    const message = (channels.error as Error).message;
    return (
      <section>
        <h1>Channels</h1>
        <p className="error">{message}</p>
        {/role|forbidden|admin/i.test(message) && (
          <p className="muted">
            Connecting a channel stores credentials that can change prices and stock on a live
            storefront, so it is restricted to administrators.
          </p>
        )}
      </section>
    );
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Channels</h1>
          <p className="muted">Where stock is listed for sale.</p>
        </div>
        {!adding && connectors.data && connectors.data.length > 0 && (
          <button type="button" onClick={() => setAdding(true)}>
            Connect a channel
          </button>
        )}
      </header>

      {adding && connectors.data && (
        <AddChannel connectors={connectors.data} onDone={() => setAdding(false)} />
      )}

      {channels.isLoading && <p className="muted">Loading…</p>}

      {channels.data?.length === 0 && !adding && (
        <div className="panel">
          <p className="muted">
            No channels connected yet. Stock will sit unallocated until one exists.
          </p>
        </div>
      )}

      {channels.data?.map((channel) => (
        <ChannelCard key={channel.id} channel={channel} />
      ))}
    </section>
  );
}

function AddChannel({
  connectors,
  onDone,
}: {
  connectors: ConnectorSummary[];
  onDone: () => void;
}) {
  const create = useCreateChannel();
  const [connectorKey, setConnectorKey] = useState(connectors[0]?.key ?? '');
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const connector = connectors.find((c) => c.key === connectorKey);

  return (
    <div className="panel">
      <h2>Connect a channel</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              connectorKey,
              displayName: displayName.trim(),
              config,
              ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
            },
            { onSuccess: onDone },
          );
        }}
      >
        <label htmlFor="connector">Connector</label>
        <select
          id="connector"
          value={connectorKey}
          onChange={(e) => {
            setConnectorKey(e.target.value);
            // Settings belong to a connector; carrying them across would submit
            // fields the new one never declared.
            setConfig({});
            setSecrets({});
          }}
        >
          {connectors.map((c) => (
            <option key={c.key} value={c.key}>
              {c.displayName}
            </option>
          ))}
        </select>

        {connector && (
          <>
            <p className="field-hint">
              {connector.description} · {describeSyncMode(connector.syncMode)}
            </p>

            <label htmlFor="displayName">Name</label>
            <input
              id="displayName"
              required
              placeholder="e.g. My Shopify Store"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />

            <SchemaForm
              schema={connector.configSchema}
              value={config}
              onChange={setConfig}
              idPrefix="new"
            />

            <SecretFields
              fields={connector.secretFields}
              alreadySet={[]}
              value={secrets}
              onChange={setSecrets}
              idPrefix="new"
            />
          </>
        )}

        <div className="inline-form">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Connecting…' : 'Connect'}
          </button>
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
        </div>

        {create.isError && <FormError error={create.error as Error} />}
      </form>
    </div>
  );
}

function ChannelCard({ channel }: { channel: Channel }) {
  const connectors = useConnectors();
  const update = useUpdateChannel();
  const remove = useDeleteChannel();

  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>(channel.config);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const connector = connectors.data?.find((c) => c.key === channel.connectorKey);
  const missingSecrets = channel.secretFieldsRequired.filter(
    (field) => !channel.secretsSet.includes(field),
  );

  return (
    <div className="panel">
      <div className="channel-head">
        <div>
          <h2>{channel.displayName}</h2>
          <p className="muted">
            <code>{channel.connectorKey}</code> · {describeSyncMode(channel.syncMode)} ·{' '}
            {channel.allocationCount} allocation{channel.allocationCount === 1 ? '' : 's'}
          </p>
        </div>
        <span className={`chip ${channel.enabled ? 'chip-pooled' : ''}`}>
          {channel.enabled ? 'enabled' : 'disabled'}
        </span>
      </div>

      {channel.healthStatus === 'error' && channel.healthDetail && (
        <p className="error">{channel.healthDetail}</p>
      )}

      {/* Until credentials exist the channel cannot authenticate, so say so
          plainly rather than letting pushes fail mysteriously later. */}
      {missingSecrets.length > 0 && (
        <p className="error">Not connected yet — still needs: {missingSecrets.join(', ')}.</p>
      )}

      {channel.webhookPath && (
        <p className="field-hint">
          Webhook endpoint:{' '}
          <code>
            {window.location.origin}
            {channel.webhookPath}
          </code>
          <br />
          Point the platform&apos;s order-created webhook here. Deliveries are rejected unless
          signed with the secret above.
        </p>
      )}

      <FileTransport channel={channel} />

      {editing && connector ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate(
              {
                id: channel.id,
                config,
                ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
              },
              {
                onSuccess: () => {
                  setSecrets({});
                  setEditing(false);
                },
              },
            );
          }}
        >
          <SchemaForm
            schema={connector.configSchema}
            value={config}
            onChange={setConfig}
            idPrefix={channel.id}
          />
          <SecretFields
            fields={connector.secretFields}
            alreadySet={channel.secretsSet}
            value={secrets}
            onChange={setSecrets}
            idPrefix={channel.id}
          />

          <div className="inline-form">
            <button type="submit" disabled={update.isPending}>
              Save
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setConfig(channel.config);
                setSecrets({});
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>

          {update.isError && <FormError error={update.error as Error} />}
        </form>
      ) : (
        <div className="inline-form">
          <button type="button" onClick={() => setEditing(true)}>
            Settings
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => update.mutate({ id: channel.id, enabled: !channel.enabled })}
            disabled={update.isPending}
          >
            {channel.enabled ? 'Disable' : 'Enable'}
          </button>

          {confirmDelete ? (
            <>
              <span className="muted">Delete permanently?</span>
              <button type="button" onClick={() => remove.mutate(channel.id)}>
                Yes, delete
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>
                No
              </button>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
      )}

      {remove.isError && <FormError error={remove.error as Error} />}
    </div>
  );
}

/**
 * The manual sync loop for a file-based channel (ADR 0002).
 *
 * A channel with no usable API still has a sync loop; the operator is the
 * transport. This is deliberately the most explanatory part of the page,
 * because unlike a webhook — which either fires or does not — a file round trip
 * only works if someone knows the order to do it in and how often.
 *
 * Rendered from declared capabilities, not from the connector key. A community
 * connector for any marketplace without an API gets this UI for free.
 */
function FileTransport({ channel }: { channel: Channel }) {
  const canExport = channel.capabilities.includes('listing.export');
  const canImportOrders = channel.capabilities.includes('orders.import');
  const canImportInventory = channel.capabilities.includes('inventory.import');

  const exportFile = useExportChannel();
  const importFile = useImportChannelFile();

  const [summary, setSummary] = useState<ImportSummary | null>(null);

  if (!canExport && !canImportOrders && !canImportInventory) return null;

  return (
    <div className="file-transport">
      <h3>Manual sync</h3>
      <p className="muted">
        This channel has no API, so stock moves by file. Upload the sales export{' '}
        <strong>before</strong> you ship — a pull sheet only lists orders still awaiting fulfilment,
        so anything already shipped has dropped off it and will never be recorded. Re-uploading the
        same file is always safe.
      </p>

      <div className="inline-form">
        {canExport && (
          <button
            type="button"
            onClick={() => {
              setSummary(null);
              exportFile.mutate(channel.id);
            }}
            disabled={exportFile.isPending}
          >
            {exportFile.isPending ? 'Preparing…' : 'Download listings'}
          </button>
        )}

        {canImportOrders && (
          <UploadButton
            label="Upload sales export"
            kind="orders"
            channelId={channel.id}
            pending={importFile.isPending}
            onUpload={(args) =>
              importFile.mutate(args, { onSuccess: setSummary, onError: () => setSummary(null) })
            }
          />
        )}

        {canImportInventory && (
          <UploadButton
            label="Upload inventory export"
            kind="inventory"
            channelId={channel.id}
            pending={importFile.isPending}
            onUpload={(args) =>
              importFile.mutate(args, { onSuccess: setSummary, onError: () => setSummary(null) })
            }
          />
        )}
      </div>

      {exportFile.isError && <FormError error={exportFile.error as Error} />}
      {importFile.isError && <FormError error={importFile.error as Error} />}

      {exportFile.isSuccess && exportFile.data && (
        <p className="field-hint">
          Downloaded <code>{exportFile.data.filename}</code> — {exportFile.data.listings} allocation
          {exportFile.data.listings === 1 ? '' : 's'} on this channel.
          {exportFile.data.unmapped > 0 && (
            <>
              {' '}
              <strong>
                {exportFile.data.unmapped} not included: no listing id on this platform yet.
              </strong>{' '}
              Create those listings on the platform, then paste their ids onto the allocations —
              matching by name would be a guess about which printing you meant.
            </>
          )}
        </p>
      )}

      {summary && <ImportResult summary={summary} />}
    </div>
  );
}

function UploadButton({
  label,
  kind,
  channelId,
  pending,
  onUpload,
}: {
  label: string;
  kind: ImportKind;
  channelId: string;
  pending: boolean;
  onUpload: (args: { id: string; kind: ImportKind; file: File }) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        className="ghost"
        onClick={() => input.current?.click()}
        disabled={pending}
      >
        {pending ? 'Reading…' : label}
      </button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first: picking the same file twice fires no change event
          // otherwise, and re-uploading is a thing operators legitimately do.
          event.target.value = '';
          if (file) onUpload({ id: channelId, kind, file });
        }}
      />
    </>
  );
}

/**
 * What the upload actually did.
 *
 * The two kinds mean different things and are not collapsed into one message:
 * an orders import moves stock, an inventory import only reports. Saying so
 * plainly is the difference between an operator trusting this loop and quietly
 * double-checking everything by hand.
 */
function ImportResult({ summary }: { summary: ImportSummary }) {
  const isOrders = summary.kind === 'orders';

  return (
    <div className="import-result">
      {summary.duplicate ? (
        <p className="field-hint">
          <strong>Already uploaded.</strong> This exact file has been processed before, so nothing
          was recorded twice.
        </p>
      ) : isOrders ? (
        <p className="field-hint">
          {summary.queued ? (
            <>
              <strong>
                {summary.recordCount} sale{summary.recordCount === 1 ? '' : 's'} queued
              </strong>{' '}
              from <code>{summary.filename}</code>. Stock updates in the background; sales already
              recorded are skipped.
            </>
          ) : (
            <>
              Nothing was recorded from <code>{summary.filename}</code>.
            </>
          )}
        </p>
      ) : (
        <p className="field-hint">
          Read {summary.recordCount} listing{summary.recordCount === 1 ? '' : 's'} from{' '}
          <code>{summary.filename}</code>.{' '}
          {summary.unmappedCount ? `${summary.unmappedCount} are not managed here. ` : ''}
          <strong>Nothing was changed</strong> — inventory exports are a report until reconciliation
          ships.
        </p>
      )}

      {summary.differences && summary.differences.length > 0 && (
        <details>
          <summary>
            {summary.differences.length} listing
            {summary.differences.length === 1 ? '' : 's'} differ from our records
          </summary>
          <table className="compact">
            <thead>
              <tr>
                <th>Listing</th>
                <th>On the platform</th>
                <th>We believe</th>
              </tr>
            </thead>
            <tbody>
              {summary.differences.slice(0, 50).map((row) => (
                <tr key={row.externalListingId}>
                  <td>
                    <code>{row.externalListingId}</code>
                  </td>
                  <td>{row.platformQuantity}</td>
                  <td>{row.believedQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {summary.problems.length > 0 && (
        <details>
          <summary>
            {summary.problems.length} problem{summary.problems.length === 1 ? '' : 's'} in this file
          </summary>
          <ul className="error">
            {summary.problems.slice(0, 50).map((problem, index) => (
              <li key={`${problem.line ?? 'file'}-${index}`}>
                {problem.line ? `Line ${problem.line}: ` : ''}
                {problem.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Surfaces the per-field issues the server returns for an invalid config,
 * rather than the single summary line.
 *
 * "Channel configuration is incomplete" tells an operator nothing; "Shop domain
 * is not in the expected format" tells them what to fix.
 */
function FormError({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? error.issues : [];

  if (issues.length === 0) return <p className="error">{error.message}</p>;

  return (
    <>
      <p className="error">{error.message}</p>
      <ul className="error">
        {issues.map((issue, index) => (
          <li key={issue.field ?? index}>{issue.message}</li>
        ))}
      </ul>
    </>
  );
}
