import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { ApiKeyService } from './api-key.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { LocalAuthProvider } from './local-auth.provider';
import { OidcService } from './oidc/oidc.service';
import { OidcController } from './oidc/oidc.controller';
import { OidcAuthProvider } from './oidc/oidc-auth.provider';
import { ResolvingAuthProvider } from './resolving-auth.provider';
import { AuthSettingsModule } from '../settings/auth-settings.module';
import { AUTH_PROVIDER } from './auth-provider.interface';

/**
 * `AUTH_PROVIDER` is the seam in auth-provider.interface.ts: nothing downstream
 * of it — sessions, the guard, RBAC — knows or cares which one is bound.
 *
 * It **was** selected at boot from configuration. It is now resolved per call
 * by `ResolvingAuthProvider`, because SSO can be configured from the settings
 * screen after first-run and an operator who has just saved a working
 * configuration should not have to recreate their container to use it. The seam
 * is unchanged; only the moment the choice is made moved.
 *
 * `OidcController` is registered either way. It refuses with a 404 when SSO is
 * not configured, which is easier to reason about than a route table that
 * changes shape with the environment.
 */
@Module({
  imports: [AuthSettingsModule],
  controllers: [AuthController, OidcController],
  providers: [
    AuthService,
    SessionService,
    PasswordService,
    ApiKeyService,
    LocalAuthProvider,
    OidcService,
    OidcAuthProvider,
    ResolvingAuthProvider,
    { provide: AUTH_PROVIDER, useExisting: ResolvingAuthProvider },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  // `PasswordService` is exported so user administration hashes with the same
  // argon2 parameters as login, rather than a second copy that could drift.
  // `OidcService` is exported for the settings screen, which derives the
  // redirect URI from it rather than rebuilding that string a second time.
  exports: [AuthService, SessionService, ApiKeyService, PasswordService, OidcService],
})
export class AuthModule {}
