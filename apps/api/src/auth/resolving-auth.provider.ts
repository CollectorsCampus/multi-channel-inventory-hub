import { Injectable } from '@nestjs/common';
import { LocalAuthProvider } from './local-auth.provider';
import { OidcService } from './oidc/oidc.service';
import { OidcAuthProvider } from './oidc/oidc-auth.provider';
import type {
  AuthProvider,
  AuthenticatedPrincipal,
  CredentialsPayload,
} from './auth-provider.interface';

/**
 * Picks the active provider at the moment it is asked, rather than at boot.
 *
 * SSO used to be selectable only through `AUTH_PROVIDER` in the environment, so
 * binding it once while the container started was exactly right. Now that an
 * admin can configure and enable it from the settings screen, a boot-time
 * binding would mean saving a working configuration and then being told to
 * restart — which is the "restart nobody expects" the settings screen was
 * originally kept read-only to avoid, arriving by the other door.
 *
 * Nothing downstream changes. `AUTH_PROVIDER` is still one binding satisfying
 * one interface; only the moment of choosing moved, and `OidcService.enabled`
 * is a cheap read of a cached snapshot rather than a query.
 *
 * **The getters must stay getters.** Reading `active` once into a field would
 * reintroduce exactly the boot-time capture this class exists to remove, and
 * the symptom would be a settings save that appears to work and changes
 * nothing until the next deploy.
 */
@Injectable()
export class ResolvingAuthProvider implements AuthProvider {
  constructor(
    private readonly oidc: OidcService,
    private readonly local: LocalAuthProvider,
    private readonly sso: OidcAuthProvider,
  ) {}

  private get active(): AuthProvider {
    return this.oidc.enabled ? this.sso : this.local;
  }

  get key(): string {
    return this.active.key;
  }

  get displayName(): string {
    return this.active.displayName;
  }

  get supportsDirectLogin(): boolean {
    return this.active.supportsDirectLogin;
  }

  authenticate(credentials: CredentialsPayload): Promise<AuthenticatedPrincipal | null> {
    return this.active.authenticate(credentials);
  }
}
