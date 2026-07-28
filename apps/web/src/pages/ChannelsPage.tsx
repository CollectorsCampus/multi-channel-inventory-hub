import { useState } from 'react';
import {
  describeSyncMode,
  useChannels,
  useConnectors,
  useCreateChannel,
  useDeleteChannel,
  useUpdateChannel,
  type Channel,
  type ConnectorSummary,
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
