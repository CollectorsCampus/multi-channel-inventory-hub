import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AuthSettingsService } from './auth-settings.service';

/**
 * The stored half of authentication configuration, on its own.
 *
 * Its own module rather than part of either neighbour, and that is the point.
 * `AuthModule` needs it — `OidcService` reads its configuration through it —
 * while `SettingsModule` needs `AuthModule`, to derive the redirect URI and
 * reuse the discovery client. Putting this service in either one makes those
 * two import each other, and the fix for that would be `forwardRef`, which
 * works and then quietly turns every future construction-time dependency
 * between them into a runtime `undefined`.
 *
 * The same reasoning `CatalogIngestModule` was split out for. A module that
 * depends only on Prisma, the credential store and the environment can be
 * imported by both sides without a cycle existing at all.
 */
@Module({
  imports: [ConnectorsModule],
  providers: [AuthSettingsService],
  exports: [AuthSettingsService],
})
export class AuthSettingsModule {}
