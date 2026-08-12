import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AlertsModule } from '../sync/alerts.module';
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
  // AlertsModule for SyslogService — the syslog form is a settings concern,
  // but the emitter has to live beside the alert writer it ships for.
  imports: [AuthSettingsModule, AuthModule, AlertsModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
