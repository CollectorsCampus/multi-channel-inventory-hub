import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
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
import { AUTH_PROVIDER, type AuthProvider } from './auth-provider.interface';

/**
 * `AUTH_PROVIDER` is selected from configuration at boot, which is the whole
 * point of the seam in auth-provider.interface.ts: nothing downstream of it —
 * sessions, the guard, RBAC — knows or cares which one is bound.
 *
 * `OidcController` is registered either way. It refuses with a 404 when SSO is
 * not configured, which is easier to reason about than a route table that
 * changes shape with the environment.
 */
@Module({
  controllers: [AuthController, OidcController],
  providers: [
    AuthService,
    SessionService,
    PasswordService,
    ApiKeyService,
    LocalAuthProvider,
    OidcService,
    OidcAuthProvider,
    {
      provide: AUTH_PROVIDER,
      inject: [ConfigService, LocalAuthProvider, OidcAuthProvider],
      useFactory: (
        config: ConfigService,
        local: LocalAuthProvider,
        oidc: OidcAuthProvider,
      ): AuthProvider => (config.get<string>('AUTH_PROVIDER') === 'oidc' ? oidc : local),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  // `PasswordService` is exported so user administration hashes with the same
  // argon2 parameters as login, rather than a second copy that could drift.
  exports: [AuthService, SessionService, ApiKeyService, PasswordService],
})
export class AuthModule {}
