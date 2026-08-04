import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthSettingsModule } from './auth-settings.module';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

/**
 * The settings screen's write half.
 *
 * Depends on `AuthModule` one way only — for `OidcService`, whose redirect URI
 * and discovery client this reuses rather than reimplementing. `AuthModule`
 * knows nothing about this module; the configuration they share lives in
 * `AuthSettingsModule`, which both import. See that file for why.
 */
@Module({
  imports: [AuthSettingsModule, AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
