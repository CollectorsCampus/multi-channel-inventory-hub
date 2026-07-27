import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { ApiKeyService } from './api-key.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { LocalAuthProvider } from './local-auth.provider';
import { AUTH_PROVIDER } from './auth-provider.interface';

/**
 * v1 binds AUTH_PROVIDER to the local username/password provider. Adding OIDC
 * (v1.x) means registering another implementation and selecting it here from
 * config — nothing downstream of the interface should need to change.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PasswordService,
    ApiKeyService,
    LocalAuthProvider,
    { provide: AUTH_PROVIDER, useExisting: LocalAuthProvider },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, SessionService, ApiKeyService],
})
export class AuthModule {}
