import { RouterProvider } from '@tanstack/react-router';
import { useCurrentUser } from './auth';
import { LoginPage } from './pages/LoginPage';
import { router } from './router';

/**
 * The router is mounted only once a session exists.
 *
 * Authentication is a whole-application gate rather than a per-route guard:
 * every route behind it needs a session, so branching here keeps the route
 * definitions free of auth concerns. The server enforces access regardless —
 * the UI only reflects permissions (§8).
 */
export function App() {
  const { data: user, isLoading, error } = useCurrentUser();

  if (isLoading) {
    return (
      <div className="centered">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="centered">
        <div className="card">
          <h1>Something went wrong</h1>
          <p className="error">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="centered">
        <LoginPage />
      </div>
    );
  }

  return <RouterProvider router={router} />;
}
