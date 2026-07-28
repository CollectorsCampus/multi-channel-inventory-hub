import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useCurrentUser, useLogout } from './auth';
import { useOpenAlertCount } from './api/sync';
import { useQueryConsoleStatus } from './api/queryConsole';

export function AppShell({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const openAlerts = useOpenAlertCount().data?.open ?? 0;
  // Off by default, so unlike the other links this one is hidden rather than
  // shown-and-explained: there is nothing behind it to explain on a deployment
  // that never turned it on.
  const queryConsole = useQueryConsoleStatus().data;

  return (
    <div className="app">
      <nav className="topbar">
        <Link to="/" className="brand">
          Inventory&nbsp;Hub
        </Link>
        <div className="topbar-nav">
          <Link to="/">Inventory</Link>
          <Link to="/intake">Add stock</Link>
          {/* Server enforces admin-only; the link is shown to everyone and the
              page explains the restriction if they lack the role (§8: the UI
              reflects permissions, it never enforces them). */}
          <Link to="/channels">Channels</Link>
          <Link to="/activity">
            Activity
            {/* An alert nobody notices is an alert that does not work. */}
            {openAlerts > 0 && <span className="badge">{openAlerts}</span>}
          </Link>
          {queryConsole?.enabled && <Link to="/query">Query</Link>}
        </div>
        <div className="topbar-right">
          {user && (
            <span className="muted">
              {user.username} · {user.role}
            </span>
          )}
          <a href="/api/docs">API</a>
          <button type="button" className="ghost" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </div>
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}
