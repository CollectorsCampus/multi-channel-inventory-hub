import { useState, type FormEvent } from 'react';
import { useAuthStatus, useLogin, useSetup } from '../auth';

/**
 * Doubles as the first-run setup screen. When the instance has no users, the
 * server reports `needsSetup` and this form creates the initial admin instead
 * of signing in (TECHNICAL_DESIGN.md §8).
 */
export function LoginPage() {
  const status = useAuthStatus();
  const login = useLogin();
  const setup = useSetup();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const needsSetup = status.data?.needsSetup ?? false;
  const pending = login.isPending || setup.isPending;
  const serverError = (login.error ?? setup.error)?.message ?? null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);

    if (needsSetup) {
      if (password !== confirmPassword) {
        setLocalError('Passwords do not match.');
        return;
      }
      if (password.length < 12) {
        setLocalError('Password must be at least 12 characters.');
        return;
      }
      setup.mutate(
        { username, password },
        { onSuccess: () => login.mutate({ username, password }) },
      );
      return;
    }

    login.mutate({ username, password });
  }

  if (status.isLoading) {
    return <p className="muted">Loading…</p>;
  }

  return (
    <div className="card">
      <h1>{needsSetup ? 'Create the first admin' : 'Sign in'}</h1>
      <p className="muted">
        {needsSetup
          ? 'This instance has no users yet. The account you create here is an administrator.'
          : status.data?.providerDisplayName}
      </p>

      <form onSubmit={handleSubmit}>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {needsSetup && (
          <>
            <label htmlFor="confirmPassword">Confirm password</label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </>
        )}

        {(localError ?? serverError) && (
          <p className="error" role="alert">
            {localError ?? serverError}
          </p>
        )}

        <button type="submit" disabled={pending}>
          {pending ? 'Working…' : needsSetup ? 'Create admin' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
