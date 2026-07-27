import type { UserRole } from '@hub/db';

/**
 * The seam that keeps authentication pluggable (TECHNICAL_DESIGN.md §8).
 *
 * v1 ships `LocalAuthProvider` (username/password, argon2id). v1.x adds a
 * generic OIDC provider. Everything downstream of this interface — sessions,
 * guards, RBAC — is provider-agnostic, so adding OIDC must not require touching
 * the session or guard layers.
 */

export interface AuthenticatedPrincipal {
  userId: string;
  username: string;
  role: UserRole;
}

export interface CredentialsPayload {
  username: string;
  password: string;
}

export interface AuthProvider {
  /** Stable key persisted on `User.provider`. */
  readonly key: string;

  readonly displayName: string;

  /**
   * True when this provider authenticates by verifying credentials this server
   * holds. False for redirect-based providers (OIDC), whose flow is driven by
   * the browser rather than by a credentials POST.
   */
  readonly supportsDirectLogin: boolean;

  /**
   * Verify credentials and resolve a principal.
   * Returns null on any failure — bad username and bad password must be
   * indistinguishable to the caller so the endpoint cannot enumerate users.
   */
  authenticate(credentials: CredentialsPayload): Promise<AuthenticatedPrincipal | null>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
