import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OidcService } from '../auth/oidc/oidc.service';
import { fetchDiscovery } from '../auth/oidc/discovery';
import { parseAllowedOrigins, parseRoleMap } from '../config/env';
import {
  AuthSettingsService,
  type OidcSettingsPatch,
  type OidcSettingsView,
} from './auth-settings.service';

/**
 * The guards around editing authentication from a browser.
 *
 * `AuthSettingsService` is the store; this is the judgement, and the split
 * matters because everything here exists to stop one of two things: an operator
 * locking themselves out, or SSO being switched on in a state where the failure
 * lands somewhere they cannot see it.
 *
 * ## Why saving validates the issuer
 *
 * Configuration used to arrive only through the environment, where a bad
 * `OIDC_ISSUER_URL` failed at **boot** — loudly, before anyone could sign in.
 * Moving it into the database moves that failure to the first **login**, which
 * is quiet, happens to whoever tries next, and on a mandatory-SSO deployment
 * happens to everyone at once.
 *
 * So discovery is fetched before a save is accepted. That is not a nicety; it
 * is the replacement for the check that was lost, and it is why enabling SSO
 * with an unreachable issuer is refused rather than merely warned about.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AuthSettingsService,
    private readonly oidc: OidcService,
  ) {}

  view(): OidcSettingsView {
    return this.settings.view(this.oidc.redirectUri());
  }

  /**
   * Check a configuration against the real provider without storing it.
   *
   * Takes the patch rather than reading what is stored, so the operator can
   * test what they have typed. The client secret is deliberately **not**
   * exercised here: discovery is unauthenticated, and the secret is only proven
   * by a real code exchange, which needs a browser and a human. Saying so
   * plainly is better than implying a green tick covers more than it does.
   */
  async test(patch: OidcSettingsPatch): Promise<{ ok: true; issuer: string; endpoints: string[] }> {
    const current = this.settings.effective();
    const issuer = patch.issuer ?? current.issuer;
    const origins = parseAllowedOrigins(
      patch.allowedEndpointOrigins ?? current.allowedEndpointOrigins,
    );

    if (issuer.trim() === '') {
      throw new BadRequestException('There is no issuer URL to test.');
    }

    const discovery = await fetchDiscovery(
      issuer,
      (url, init) => fetch(url, init),
      undefined,
      origins,
    ).catch((error: Error) => {
      throw new BadRequestException(error.message);
    });

    return {
      ok: true,
      issuer: discovery.issuer,
      endpoints: [discovery.authorizationEndpoint, discovery.tokenEndpoint, discovery.jwksUri],
    };
  }

  async update(raw: OidcSettingsPatch): Promise<OidcSettingsView> {
    // `class-transformer` materialises every declared property on the DTO, so a
    // body naming only `enabled` still arrives with `clientId: undefined` and
    // the rest beside it. Spreading that straight over the effective settings
    // replaced real values with `undefined` and the next `.trim()` threw a 500
    // — where the whole point of this method is to answer with a reason. So the
    // patch is narrowed to what was actually sent, once, before anything reads
    // it.
    const patch = Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined),
    ) as OidcSettingsPatch;

    const current = this.settings.effective();
    const next = { ...current, ...patch };

    if (patch.roleMap !== undefined && patch.roleMap.trim() !== '') {
      // Parsed here rather than at use: a malformed map read during a login
      // would fall back to the default role silently, which is exactly the
      // failure #73 was about.
      try {
        parseRoleMap(patch.roleMap);
      } catch (error) {
        throw new BadRequestException(`Role map: ${(error as Error).message}`, { cause: error });
      }
    }

    if (patch.allowedEndpointOrigins !== undefined) {
      try {
        parseAllowedOrigins(patch.allowedEndpointOrigins);
      } catch (error) {
        throw new BadRequestException((error as Error).message, { cause: error });
      }
    }

    // Enabling is the only transition that can hurt, so it is the only one that
    // pays for a network round trip.
    if (next.enabled && !current.enabled) {
      if (next.issuer.trim() === '' || next.clientId.trim() === '') {
        throw new BadRequestException(
          'SSO needs an issuer URL and a client id before it can be switched on.',
        );
      }
      if (next.clientSecret === '') {
        throw new BadRequestException(
          'SSO needs a client secret. This hub exchanges the code server-side, so the ' +
            'provider must have issued one.',
        );
      }
      await this.test(patch);
    }

    if (patch.allowLocalLogin === false) await this.assertSsoHasWorked();

    try {
      await this.settings.save(patch);
    } catch (error) {
      // `save` refuses environment-owned fields, and that reads as a client
      // error rather than a server fault.
      throw new BadRequestException((error as Error).message, { cause: error });
    }

    this.logger.log(
      `Authentication settings updated: ${Object.keys(patch)
        .filter((k) => k !== 'clientSecret')
        .join(', ')}${patch.clientSecret !== undefined ? ', clientSecret' : ''}.`,
    );

    return this.view();
  }

  /**
   * Refuse to close the password door until SSO has actually let someone in.
   *
   * The same shape as the user module's lock-out rules, and for the same
   * reason: the caller is authorised, the *outcome* is refused, and there is no
   * undo short of editing the database. A redirect URI with a typo in it looks
   * identical to a working one until the moment somebody tries to use it.
   */
  private async assertSsoHasWorked(): Promise<void> {
    const signedIn = await this.prisma.user.count({
      where: { provider: 'oidc', isActive: true, lastLoginAt: { not: null } },
    });

    if (signedIn === 0) {
      throw new BadRequestException(
        'No SSO user has signed in yet, so password login cannot be turned off — a mistyped ' +
          'redirect URI would lock everyone out. Sign in through SSO once, then disable it.',
      );
    }
  }
}
