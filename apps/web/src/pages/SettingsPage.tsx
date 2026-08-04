import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAuthStatus, useCurrentUser } from '../auth';
import { useDevMode } from '../devMode';
import { useQueryConsoleStatus } from '../api/queryConsole';
import { useChannels } from '../api/channels';
import {
  useOidcSettings,
  useTestOidcSettings,
  useUpdateOidcSettings,
  type OidcField,
  type OidcSettingsPatch,
} from '../api/settings';
import {
  ROLE_DESCRIPTIONS,
  USER_ROLES,
  useCreateUser,
  useDeleteUser,
  useSetUserPassword,
  useUpdateUser,
  useUsers,
  type User,
  type UserRole,
} from '../api/users';

/**
 * Settings: what this deployment is, who can use it, and where the rest is.
 *
 * Deliberately not a dumping ground for everything configurable. Two kinds of
 * setting are *not* here and should stay away:
 *
 * - **Per-channel settings** live on the channel, because that is the thing
 *   they belong to and a channel picker on a settings page is just a worse
 *   version of the channels screen.
 * - **Environment configuration** is reported read-only, because a form over a
 *   value read once at boot would lie about when it takes effect.
 *
 * Single sign-on is the one thing that crossed that line, and it kept the rule
 * rather than breaking it: a field the environment declares is shown **locked**
 * and the server refuses to write it, so the form still only offers what it
 * actually controls. It earned the exception because "add an identity provider"
 * is done once, after the first local admin exists, by someone running a
 * published image who has no reason to be holding a shell.
 */
export function SettingsPage() {
  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === 'admin';

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">What this instance is running, and who can use it.</p>
        </div>
      </header>

      <Deployment />
      {isAdmin && <SingleSignOn />}
      <Navigation />

      {/* Server-enforced; the panel is shown to everyone and explains itself,
          the same rule the channels screen follows. */}
      {isAdmin ? <Users /> : <p className="muted">User administration needs the admin role.</p>}
    </section>
  );
}

/**
 * Read-only, and that is the honest shape. Every value here comes from the
 * environment and is read at boot — a form would imply it could be changed
 * from a browser, which would either be a lie or a restart nobody expects.
 */
function Deployment() {
  const status = useAuthStatus();
  const queryConsole = useQueryConsoleStatus();
  const channels = useChannels();

  const rows: Array<[string, string]> = [
    ['Sign-in', status.data?.providerDisplayName ?? '…'],
    [
      'Password login',
      status.data?.supportsDirectLogin
        ? status.data.ssoStartPath
          ? 'Allowed alongside SSO (break-glass)'
          : 'The only way in'
        : 'Disabled — SSO only',
    ],
    ['Query console', queryConsole.data?.enabled ? 'Enabled' : 'Disabled'],
    ['Channels', channels.data ? String(channels.data.length) : '…'],
  ];

  return (
    <div className="panel">
      <h2>This deployment</h2>
      <dl className="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="field-hint">
        Set in the environment and read at boot, so these are reported rather than edited. Change
        them in <code>.env</code> and restart. Per-channel settings — including what a created
        listing carries — live on <Link to="/channels">Channels</Link>.
      </p>
    </div>
  );
}

/**
 * Single sign-on, editable — except where the environment owns a field.
 *
 * Two things here are guards rather than decoration, and both mirror rules the
 * server enforces:
 *
 * - **A locked field is disabled and says why.** The server refuses to write
 *   one, so an enabled input would be a control that does nothing.
 * - **Test before enabling.** Switching SSO on with an unreachable issuer used
 *   to be impossible — a bad `OIDC_ISSUER_URL` failed at boot. Stored
 *   configuration moves that failure to somebody's next login, so the server
 *   fetches discovery before accepting the change and this offers the same
 *   check up front.
 */
function SingleSignOn() {
  const settings = useOidcSettings(true);
  const update = useUpdateOidcSettings();
  const test = useTestOidcSettings();

  const [patch, setPatch] = useState<OidcSettingsPatch>({});
  const view = settings.data;

  if (settings.isError) {
    return (
      <div className="panel">
        <h2>Single sign-on</h2>
        <p className="muted">Could not be read. It needs the admin role.</p>
      </div>
    );
  }
  if (!view) return null;

  const field = (name: OidcField) => view.fields[name];
  const locked = (name: OidcField) => field(name).managedByEnv;
  const current = (name: OidcField) => (patch[name] as string | undefined) ?? field(name).value;
  const set = (name: OidcField, value: string | boolean) =>
    setPatch((p) => ({ ...p, [name]: value }));

  const enabled = (patch.enabled ?? field('enabled').value === 'true') === true;
  const dirty = Object.keys(patch).length > 0;

  // `.field` is the stacking class the rest of the app uses. There is no
  // `.stacked`; inventing one rendered every control on a single run-on line,
  // which no test could have caught and the accessibility tree reported as
  // perfectly well-formed.
  const text = (name: OidcField, label: string, hint?: string, placeholder?: string) => (
    <label className="field" key={name}>
      <span>
        {label}
        {locked(name) && <span className="chip"> set by the environment</span>}
      </span>
      <input
        value={current(name)}
        disabled={locked(name)}
        placeholder={placeholder}
        onChange={(event) => set(name, event.target.value)}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );

  return (
    <div className="panel">
      <h2>Single sign-on</h2>
      <p className="muted">
        Any OpenID Connect provider, with PKCE. Applies immediately — no restart. Register{' '}
        <code>{view.redirectUri}</code> as the redirect URI with your provider.
      </p>

      <label className="inline-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={locked('enabled')}
          onChange={(event) => set('enabled', event.target.checked)}
        />
        Offer SSO on the login screen
        {locked('enabled') && <span className="chip">set by the environment</span>}
      </label>

      {text(
        'issuer',
        'Issuer URL',
        'The base URL; discovery appends /.well-known/openid-configuration. For Entra use your tenant id, never "common".',
        'https://login.microsoftonline.com/<tenant>/v2.0',
      )}
      {text('clientId', 'Client ID')}

      <label className="field">
        <span>
          Client secret
          {locked('clientSecret') && <span className="chip"> set by the environment</span>}
        </span>
        <input
          type="password"
          value={patch.clientSecret ?? ''}
          disabled={locked('clientSecret')}
          placeholder={view.clientSecretSet ? 'Stored — leave blank to keep' : 'Not set'}
          onChange={(event) => set('clientSecret', event.target.value)}
        />
        <span className="field-hint">
          Stored encrypted and never shown again. Register the app as a <em>Web</em> client, not a
          single-page application — the code is exchanged here, with this secret.
        </span>
      </label>

      {text('scopes', 'Scopes')}
      {text(
        'roleClaim',
        'Role claim',
        'Set it and the provider becomes authoritative: the mapped role is reapplied on every login. Blank leaves roles managed here.',
        'roles',
      )}
      {text(
        'roleMap',
        'Role map',
        'Matched exactly, including case. An unmapped value falls back to the default role and is logged.',
        '{"admin":"admin","viewer":"viewer"}',
      )}

      <label className="field">
        <span>
          Role for anyone unmapped
          {locked('defaultRole') && <span className="chip"> set by the environment</span>}
        </span>
        <select
          value={current('defaultRole')}
          disabled={locked('defaultRole')}
          onChange={(event) => set('defaultRole', event.target.value)}
        >
          {USER_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>

      <label className="inline-check">
        <input
          type="checkbox"
          checked={(patch.allowLocalLogin ?? field('allowLocalLogin').value === 'true') === true}
          disabled={locked('allowLocalLogin')}
          onChange={(event) => set('allowLocalLogin', event.target.checked)}
        />
        Keep password login working
        {locked('allowLocalLogin') && <span className="chip">set by the environment</span>}
      </label>
      <p className="field-hint">
        Break-glass. Turning it off is refused until an SSO user has actually signed in, because a
        mistyped redirect URI would otherwise lock everyone out.
      </p>

      {text(
        'allowedEndpointOrigins',
        'Extra endpoint origins',
        'Only if the provider serves endpoints off its issuer’s origin. Google does; Entra, Auth0, Keycloak and Okta do not.',
        'https://oauth2.googleapis.com',
      )}

      <div className="inline-form">
        <button
          type="button"
          onClick={() => test.mutate(patch)}
          disabled={test.isPending || current('issuer') === ''}
        >
          {test.isPending ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => update.mutate(patch, { onSuccess: () => setPatch({}) })}
          disabled={!dirty || update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
        {dirty && <span className="muted">Unsaved changes</span>}
      </div>

      {test.isSuccess && (
        <p className="field-hint">
          Reached <code>{test.data.issuer}</code>. This proves the issuer resolves and its endpoints
          are allowed — it does <em>not</em> check the client secret, which only a real sign-in
          exercises.
        </p>
      )}
      {test.isError && <p className="error">{(test.error as Error).message}</p>}
      {update.isError && <p className="error">{(update.error as Error).message}</p>}
    </div>
  );
}

/**
 * The screens that are reached from somewhere specific rather than the nav.
 *
 * Listing them here is the point: each is linked from the channel it applies
 * to, which is right, and also means someone who knows the screen exists has
 * no way to find it again.
 */
function Navigation() {
  const [devMode, setDevMode] = useDevMode();
  const queryConsole = useQueryConsoleStatus();

  return (
    <div className="panel">
      <h2>Navigation</h2>

      <label className="inline-check">
        <input
          type="checkbox"
          checked={devMode}
          onChange={(event) => setDevMode(event.target.checked)}
        />
        Show every screen in the top navigation
      </label>

      <p className="field-hint">
        Matching, listing and the query console act on one channel, so they are normally reached
        from it. This adds them to the nav as well. It only shows links — each screen still checks
        your role, and typing the address always worked.
      </p>

      <ul className="link-list">
        <li>
          <Link to="/match">Match listings</Link> — link what a channel already sells to the
          catalogue.
        </li>
        <li>
          <Link to="/list">List on a channel</Link> — create listings for stock a channel does not
          carry.
        </li>
        <li>
          <Link to="/query">Query console</Link> —{' '}
          {queryConsole.data?.enabled
            ? 'read-only SQL, admin only.'
            : 'disabled on this deployment.'}
        </li>
      </ul>
    </div>
  );
}

function Users() {
  const users = useUsers();

  return (
    <div className="panel">
      <h2>Users</h2>

      {users.isError && <p className="error">{(users.error as Error).message}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Sign-in</th>
              <th>Role</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((account) => (
              <UserRow key={account.id} account={account} />
            ))}
          </tbody>
        </table>
      </div>

      <NewUser />
    </div>
  );
}

function UserRow({ account }: { account: User }) {
  const update = useUpdateUser();
  const remove = useDeleteUser();
  const setPassword = useSetUserPassword();
  const [password, setPassword_] = useState('');
  const [resetting, setResetting] = useState(false);

  const failure = (update.error ?? remove.error ?? setPassword.error) as Error | null;

  return (
    <>
      <tr className={account.isActive ? undefined : 'row-muted'}>
        <td>
          <span className="cell-title">{account.displayName || account.username}</span>
          <span className="cell-sub">
            {account.displayName ? account.username : (account.email ?? '—')}
          </span>
        </td>
        <td>
          <span className="chip">{account.provider}</span>
          {/* An SSO account with no password cannot use the break-glass door,
              which is worth seeing before disabling SSO rather than after. */}
          {!account.hasPassword && <span className="cell-sub">no password</span>}
        </td>
        <td>
          <select
            value={account.role}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate({ id: account.id, role: event.target.value as UserRole })
            }
            aria-label={`Role for ${account.username}`}
          >
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </td>
        <td className="muted">
          {account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleDateString() : 'never'}
        </td>
        <td className="row-actions">
          <button
            type="button"
            className="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: account.id, isActive: !account.isActive })}
          >
            {account.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
          {account.provider === 'local' && (
            <button type="button" className="ghost" onClick={() => setResetting((v) => !v)}>
              Set password
            </button>
          )}
          <button
            type="button"
            className="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate(account.id)}
          >
            Delete
          </button>
        </td>
      </tr>

      {resetting && (
        <tr>
          <td colSpan={5}>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                setPassword.mutate(
                  { id: account.id, password },
                  {
                    onSuccess: () => {
                      setPassword_('');
                      setResetting(false);
                    },
                  },
                );
              }}
            >
              <label htmlFor={`pw-${account.id}`}>New password for {account.username}</label>
              <input
                id={`pw-${account.id}`}
                type="password"
                value={password}
                minLength={12}
                onChange={(event) => setPassword_(event.target.value)}
              />
              <button type="submit" disabled={setPassword.isPending}>
                Set
              </button>
              <span className="muted">Signs them out everywhere.</span>
            </form>
          </td>
        </tr>
      )}

      {failure && (
        <tr>
          <td colSpan={5}>
            <p className="error">{failure.message}</p>
          </td>
        </tr>
      )}
    </>
  );
}

function NewUser() {
  const create = useCreateUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('editor');

  return (
    <>
      <h3>Add someone</h3>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            { username: username.trim(), password, role },
            {
              onSuccess: () => {
                setUsername('');
                setPassword('');
              },
            },
          );
        }}
      >
        <label htmlFor="new-username">Username</label>
        <input
          id="new-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />

        <label htmlFor="new-password">Password</label>
        <input
          id="new-password"
          type="password"
          value={password}
          minLength={12}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <label htmlFor="new-role">Role</label>
        <select
          id="new-role"
          value={role}
          onChange={(event) => setRole(event.target.value as UserRole)}
        >
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </form>

      <p className="field-hint">
        {ROLE_DESCRIPTIONS[role]} At least 12 characters — length only, no composition rules.
        Accounts created here sign in with a password; identity-provider accounts appear on their
        first login.
      </p>

      {create.isError && <p className="error">{(create.error as Error).message}</p>}
    </>
  );
}
