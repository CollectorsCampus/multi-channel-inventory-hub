import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useCurrentUser, useLogout } from './auth';

export function AppShell({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const logout = useLogout();

  return (
    <div className="app">
      <nav className="topbar">
        <Link to="/" className="brand">
          Inventory&nbsp;Hub
        </Link>
        <div className="topbar-nav">
          <Link to="/">Inventory</Link>
          <Link to="/intake">Add stock</Link>
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
