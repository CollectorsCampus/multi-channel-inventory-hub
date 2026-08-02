import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  describeDriftKind,
  describeSyncMode,
  useChannels,
  useConnectors,
  useCreateChannel,
  useDeleteChannel,
  useExportChannel,
  useImportChannelFile,
  useReconcileChannel,
  useUpdateChannel,
  type Channel,
  type ConnectorSummary,
  type ImportKind,
  type ImportSummary,
  type ReconcileOutcome,
} from '../api/channels';
import { SchemaForm, SecretFields } from '../components/SchemaForm';
import { ApiError } from '../api/client';
import { useChannelTags } from '../api/listings';

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
              optional={connector.optionalSecretFields}
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

      {/* An allocation cannot push until it holds the channel's own listing id,
          and for Shopify that id belongs to a variant the operator already
          created. This is where those get joined up. */}
      {channel.capabilities.includes('listing.enumerate') && (
        <p className="field-hint">
          <Link to="/match">Match listings →</Link> Link products already on this channel to
          inventory, one set at a time.
        </p>
      )}

      {/* The other direction: stock the ledger holds and the channel does not.
          Drafts only, for items picked by hand. */}
      {channel.capabilities.includes('listing.create') && (
        <p className="field-hint">
          <Link to="/list">List on this channel →</Link> Create draft listings for selected items
          the channel does not carry yet.
        </p>
      )}

      <ListingDefaults channel={channel} />

      <Reconciliation channel={channel} />

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
            optional={connector.optionalSecretFields}
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
 * What a listing created on this channel should carry, and whether to create
 * one for new stock automatically.
 *
 * Here rather than on a settings page because it belongs to the channel: the
 * values are that channel's own vocabulary and mean nothing anywhere else.
 *
 * The tags are picked from what the store already uses, never typed from
 * memory and never derived — a tag the store does not use puts the product in
 * no collection, which is invisible in the shop and reported by nothing. The
 * server refuses the automatic toggle until something has been declared, so
 * the two controls are deliberately next to each other.
 */
function ListingDefaults({ channel }: { channel: Channel }) {
  const update = useUpdateChannel();
  const vocabulary = useChannelTags(channel.id, channel.capabilities.includes('listing.tags'));

  const [tags, setTags] = useState<string[]>(channel.listingDefaults.tags ?? []);
  const [vendor, setVendor] = useState(channel.listingDefaults.vendor ?? '');
  const [draft, setDraft] = useState('');

  if (!channel.capabilities.includes('listing.create')) return null;

  const declared =
    channel.listingDefaults.tags !== undefined ||
    channel.listingDefaults.vendor !== undefined ||
    channel.listingDefaults.category !== undefined ||
    channel.listingDefaults.metafields !== undefined;

  const addTag = () => {
    const value = draft.trim();
    if (value && !tags.includes(value)) setTags([...tags, value]);
    setDraft('');
  };

  const save = () =>
    update.mutate({
      id: channel.id,
      listingDefaults: {
        // Sent even when empty, because an empty list is an answer — "no tags"
        // — and the only way to express it. Omitting it would read as "unset"
        // and leave the previous value in place.
        tags,
        ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
        // Carried through untouched: this form does not edit them, and dropping
        // them would silently discard a category or custom fields set elsewhere.
        ...(channel.listingDefaults.category !== undefined
          ? { category: channel.listingDefaults.category }
          : {}),
        ...(channel.listingDefaults.metafields !== undefined
          ? { metafields: channel.listingDefaults.metafields }
          : {}),
      },
    });

  return (
    <div className="file-transport">
      <h3>New listings</h3>
      <p className="muted">
        Applied verbatim to products created here. The hub never invents a tag — pick from what the
        store already uses.
      </p>

      <div className="inline-form">
        <label htmlFor={`tag-${channel.id}`}>Tags</label>
        <input
          id={`tag-${channel.id}`}
          list={`tags-${channel.id}`}
          value={draft}
          placeholder={vocabulary.data ? 'Pick or type…' : 'Type a tag…'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // Inside a card that has its own forms; Enter must add a tag, not
            // submit something else.
            event.preventDefault();
            addTag();
          }}
        />
        <datalist id={`tags-${channel.id}`}>
          {(vocabulary.data ?? []).map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        {/* An explicit button, not just Enter. With a datalist open the browser
            spends Enter on accepting the highlighted suggestion, so picking a
            tag from the list and pressing Enter adds nothing and looks broken —
            which is exactly what happened the first time this was driven. Enter
            stays as a shortcut for someone typing a tag the store does not have
            yet. */}
        <button type="button" className="ghost" onClick={addTag} disabled={draft.trim() === ''}>
          Add tag
        </button>

        <label htmlFor={`vendor-${channel.id}`}>Vendor</label>
        <input
          id={`vendor-${channel.id}`}
          value={vendor}
          placeholder="optional"
          onChange={(event) => setVendor(event.target.value)}
        />

        <button type="button" onClick={save} disabled={update.isPending}>
          Save
        </button>
      </div>

      {tags.length > 0 && (
        <span className="chips">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="chip"
              title="Remove"
              onClick={() => setTags(tags.filter((t) => t !== tag))}
            >
              {tag} ×
            </button>
          ))}
        </span>
      )}

      <label className="inline-check">
        <input
          type="checkbox"
          checked={channel.autoListNewStock}
          disabled={update.isPending || !declared}
          onChange={(event) =>
            update.mutate({ id: channel.id, autoListNewStock: event.target.checked })
          }
        />
        List new stock here as it is taken in
      </label>

      <p className="field-hint">
        {declared
          ? 'Adding stock creates a draft product carrying the above. Nothing becomes buyable ' +
            'until you publish it — and these apply to every card, so use the list screen for a ' +
            'mixed batch.'
          : 'Save what a created product should carry first. Without it the hub would have to ' +
            'guess a tag, and a guessed tag means a product in no collection.'}
      </p>

      {vocabulary.isError && (
        <p className="field-hint">
          The store&rsquo;s tag list could not be read, so there are no suggestions. Tags can still
          be typed — spelling must match exactly.
        </p>
      )}
      {update.isError && <FormError error={update.error as Error} />}
    </div>
  );
}

/**
 * Reconciliation (§6) — does the channel show what we think it shows?
 *
 * Shown only for connectors declaring `reconcile`. A file-based channel is
 * deliberately excluded: its data is only as current as the last human round
 * trip, so there is nothing live to compare against and presenting a
 * "reconcile" button would imply a guarantee it cannot make.
 */
function Reconciliation({ channel }: { channel: Channel }) {
  const reconcile = useReconcileChannel();
  const update = useUpdateChannel();
  const [outcome, setOutcome] = useState<ReconcileOutcome | null>(null);

  if (!channel.capabilities.includes('reconcile')) return null;

  return (
    <div className="file-transport">
      <h3>Reconciliation</h3>
      <p className="muted">
        Compares every listing against what we last pushed. Runs nightly on its own;{' '}
        {channel.lastReconciledAt ? (
          <>
            last run{' '}
            <time dateTime={channel.lastReconciledAt}>{formatWhen(channel.lastReconciledAt)}</time>.
          </>
        ) : (
          <>it has not run yet.</>
        )}
      </p>

      <div className="inline-form">
        <button
          type="button"
          onClick={() => {
            setOutcome(null);
            reconcile.mutate(channel.id, { onSuccess: setOutcome });
          }}
          disabled={reconcile.isPending}
        >
          {reconcile.isPending ? 'Checking…' : 'Reconcile now'}
        </button>

        <label className="inline-check">
          <input
            type="checkbox"
            checked={channel.reconcileAutoCorrect}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate({ id: channel.id, reconcileAutoCorrect: event.target.checked })
            }
          />
          Re-push automatically when quantities differ
        </label>
      </div>

      <p className="field-hint">
        Auto-correction only ever pushes our numbers to the channel. The ledger is never rewritten
        from a channel, so a platform reporting a wrong figure cannot become the source of truth.
      </p>

      {reconcile.isError && <FormError error={reconcile.error as Error} />}
      {outcome && <ReconcileResult outcome={outcome} />}
    </div>
  );
}

function ReconcileResult({ outcome }: { outcome: ReconcileOutcome }) {
  const { report } = outcome;

  return (
    <div className="import-result">
      <p className="field-hint">
        {report.drifts.length === 0 ? (
          <>
            <strong>Everything matches.</strong> Checked {report.checked} listing
            {report.checked === 1 ? '' : 's'}.
          </>
        ) : (
          <>
            <strong>
              {report.drifts.length} of {report.checked} listing
              {report.checked === 1 ? '' : 's'} differ.
            </strong>
            {outcome.corrected > 0 && ` Re-pushed ${outcome.corrected}.`}
          </>
        )}
        {report.pending.length > 0 && (
          <>
            {' '}
            {report.pending.length} still waiting on a push that has not landed — the channel is
            showing what we last told it, not what the ledger says now.
          </>
        )}
      </p>

      {report.drifts.length > 0 && (
        <details open>
          <summary>What differs</summary>
          <table className="compact">
            <thead>
              <tr>
                <th>Listing</th>
                <th>Finding</th>
                <th>We pushed</th>
                <th>Channel shows</th>
              </tr>
            </thead>
            <tbody>
              {report.drifts.slice(0, 50).map((drift) => (
                <tr key={`${drift.allocationId}-${drift.kind}`}>
                  <td>
                    <code>{drift.externalListingId}</code>
                  </td>
                  <td>{describeDriftKind(drift.kind)}</td>
                  <td>{drift.ours ?? '—'}</td>
                  <td>{drift.theirs ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {report.unmanaged.length > 0 && (
        <details>
          <summary>
            {report.unmanaged.length} listing{report.unmanaged.length === 1 ? '' : 's'} on the
            channel we do not manage
          </summary>
          <p className="field-hint">
            Not a fault — you can list things outside the hub. Shown because it is the only signal
            that the two sides disagree about what exists.
          </p>
          <ul>
            {report.unmanaged.slice(0, 50).map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Relative for the recent past, absolute once it stops being useful. */
function formatWhen(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  return then.toLocaleString();
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
        This channel has no API, so data moves by file. Upload the sales export{' '}
        <strong>before</strong> you ship — a pull sheet only lists orders still awaiting fulfilment,
        so anything already shipped has dropped off it and will never be recorded. Re-uploading the
        same file is always safe.
      </p>

      {canExport && (
        <p className="field-hint">
          The download sets <strong>prices only</strong>. TCGPlayer&apos;s import can add to or
          subtract from a quantity but cannot set one, and a file that added stock every time you
          sent it would not be safe to re-upload — so quantities stay yours to manage there. Upload
          their inventory export back here to see where the two disagree.
        </p>
      )}

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
            {exportFile.isPending ? 'Preparing…' : 'Download prices'}
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
