import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useCurrentUser, useLogout } from './auth';
import { useOpenAlertCount } from './api/sync';
import { useQueryConsoleStatus } from './api/queryConsole';
import { useDevMode } from './devMode';

export function AppShell({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const openAlerts = useOpenAlertCount().data?.open ?? 0;
  // Off by default, so unlike the other links this one is hidden rather than
  // shown-and-explained: there is nothing behind it to explain on a deployment
  // that never turned it on.
  const queryConsole = useQueryConsoleStatus().data;
  const [devMode] = useDevMode();

  return (
    <div className="app">
      <nav className="topbar">
        <Link to="/" className="brand">
          Inventory&nbsp;Hub
        </Link>
        <div className="topbar-nav">
          <Link to="/">Inventory</Link>
          <Link to="/intake">Add stock</Link>
          <Link to="/catalog">Catalog</Link>
          {/* Server enforces admin-only; the link is shown to everyone and the
              page explains the restriction if they lack the role (§8: the UI
              reflects permissions, it never enforces them). */}
          <Link to="/channels">Channels</Link>
          <Link to="/activity">
            Activity
            {/* An alert nobody notices is an alert that does not work. */}
            {openAlerts > 0 && <span className="badge">{openAlerts}</span>}
          </Link>

          {/* Normally reached from the channel they act on, which is the right
              default; developer mode surfaces them for someone who knows they
              exist and would otherwise have to remember the URL. */}
          {devMode && (
            <>
              <Link to="/match">Match</Link>
              <Link to="/list">List</Link>
            </>
          )}
          {/* Unchanged: already gated on the deployment having enabled it, which
              is a stronger condition than a navigation preference. */}
          {queryConsole?.enabled && <Link to="/query">Query</Link>}
        </div>

        <div className="topbar-right">
          <AccountMenu username={user?.username} role={user?.role} />
        </div>
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}

/**
 * The signed-in user's own menu.
 *
 * Replaces a bare "name · role" label and a Sign out button. Settings had
 * nowhere to live in the top navigation — it is not a place you go while
 * working, it is where you go to change how the thing behaves — and hanging it
 * off the account is where every tool of this shape puts it.
 */
function AccountMenu({ username, role }: { username?: string; role?: string }) {
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. Without both, the menu is a trap on
  // touch devices, where there is no stray click to dismiss it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!username) return null;

  return (
    <div className="account" ref={container}>
      <button
        type="button"
        className="account-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {username}
        <span className="muted"> · {role}</span>
        <span aria-hidden="true"> ▾</span>
      </button>

      {open && (
        <div className="account-menu" role="menu">
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)}>
            Settings
          </Link>
          {/* A full page load, not a route: this is the API's own docs served
              by the server, not part of the SPA. */}
          <a href="/api/docs" role="menuitem">
            API docs
          </a>
          <button type="button" role="menuitem" className="ghost" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
