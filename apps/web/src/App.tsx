import { useCurrentUser } from './auth';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';

/**
 * Phase 0 has exactly two states, so the shell is a conditional rather than a
 * router. TanStack Router is introduced in Phase 1 alongside the first real
 * route tree (inventory browser, item detail) — adding it now would be
 * boilerplate around a single screen.
 */
export function App() {
  const { data: user, isLoading, error } = useCurrentUser();

  if (isLoading) return <p className="muted">Loading…</p>;

  if (error) {
    return (
      <div className="card">
        <h1>Something went wrong</h1>
        <p className="error">{error.message}</p>
      </div>
    );
  }

  return user ? <DashboardPage user={user} /> : <LoginPage />;
}
