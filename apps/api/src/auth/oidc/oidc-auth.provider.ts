import { Injectable } from '@nestjs/common';
import { LocalAuthProvider } from '../local-auth.provider';
import { OidcService } from './oidc.service';
import type {
  AuthProvider,
  AuthenticatedPrincipal,
  CredentialsPayload,
} from '../auth-provider.interface';

/**
 * The `AuthProvider` face of OIDC (§8).
 *
 * The interesting part of the flow is redirect-driven and lives in
 * `OidcController`; this exists so the rest of the application — the status
 * endpoint, the login page, the guard — keeps talking to one interface, exactly
 * as the seam was designed for.
 *
 * ## Break-glass
 *
 * `authenticate()` is not dead code here. With `OIDC_ALLOW_LOCAL_LOGIN` on — the
 * default — it delegates to the local provider, so an operator whose identity
 * provider is unreachable, whose redirect URI is mistyped, or whose client
 * secret has just been rotated can still get into their own instance with a
 * password.
 *
 * That is a deliberate trade. Self-hosted software that locks its owner out of
 * their own inventory has failed more completely than one that keeps a second
 * door, and the door is only open to accounts that already had a password: the
 * local provider refuses any user whose `provider` is not `local`, so an SSO
 * identity cannot be impersonated through it. Deployments that mandate SSO turn
 * it off once the flow is proven.
 */
@Injectable()
export class OidcAuthProvider implements AuthProvider {
  readonly key = 'oidc';
  readonly displayName = 'Single sign-on';

  constructor(
    private readonly oidc: OidcService,
    private readonly local: LocalAuthProvider,
  ) {}

  /**
   * Whether the login page should still offer a password form.
   *
   * The primary flow is a redirect either way; this reports only whether the
   * break-glass path is available.
   */
  get supportsDirectLogin(): boolean {
    return this.oidc.settings().allowLocalLogin;
  }

  async authenticate(credentials: CredentialsPayload): Promise<AuthenticatedPrincipal | null> {
    if (!this.oidc.settings().allowLocalLogin) return null;
    return this.local.authenticate(credentials);
  }
}
