import { useLogout } from '../auth';
import type { CurrentUser } from '../api/client';

export function DashboardPage({ user }: { user: CurrentUser }) {
  const logout = useLogout();

  return (
    <div className="card">
      <h1>Inventory Hub</h1>
      <p className="muted">
        Signed in as <strong>{user.username}</strong> ({user.role})
      </p>

      <p>
        Phase 0 scaffold. The inventory browser, item detail and allocation editor arrive in
        Phase&nbsp;1; channel configuration and sync activity follow in Phases&nbsp;2–5.
      </p>

      <p className="muted">
        <a href="/api/docs">API documentation</a>
      </p>

      <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
        Sign out
      </button>
    </div>
  );
}
