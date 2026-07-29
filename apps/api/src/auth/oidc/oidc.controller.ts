import { Controller, Get, Logger, NotFoundException, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../decorators';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from '../session.service';
import { OidcService, LOGIN_TIMEOUT_MS, type LoginHandshake } from './oidc.service';

/**
 * The two redirect endpoints of the OIDC code flow (§8).
 *
 * Both are `@Public()` by necessity — the whole point is that the caller is not
 * yet authenticated. What stands in for authentication here is the `state`
 * value in the handshake cookie, which is why that cookie is signed and why the
 * callback refuses to proceed without it.
 *
 * Browser redirects, not JSON: the SPA sends the user here with a link and gets
 * them back with a session cookie already set.
 */

/** Holds the in-flight login. Short-lived, signed, and cleared on the way out. */
const HANDSHAKE_COOKIE = 'hub_oidc';

@ApiTags('auth')
@Controller('auth/oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);

  constructor(
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Send the browser to the identity provider.
   *
   * A GET that redirects, because it is reached from an anchor on the login
   * page. It changes no state on this server beyond setting the handshake
   * cookie, which is what makes that acceptable.
   */
  @Public()
  @Get('start')
  @ApiOperation({ summary: 'Begin an SSO login by redirecting to the identity provider.' })
  async start(
    @Query('returnTo') returnTo: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.assertEnabled();

    const { url, handshake } = await this.oidc.beginLogin(returnTo ?? '/');

    reply
      .setCookie(HANDSHAKE_COOKIE, JSON.stringify(handshake), {
        httpOnly: true,
        // Lax, not Strict: the browser arrives back on a cross-site redirect
        // from the provider, and Strict would withhold the cookie exactly then.
        sameSite: 'lax',
        secure: this.secureCookies(),
        signed: true,
        path: '/api/auth/oidc',
        maxAge: Math.floor(LOGIN_TIMEOUT_MS / 1000),
      })
      .redirect(url, 302);
  }

  /**
   * Receive the authorization code and turn it into a session.
   *
   * Errors redirect back to the sign-in page carrying a message rather than
   * rendering JSON: a person who has just been bounced through their identity
   * provider should land somewhere they can try again, not on a raw error body.
   */
  @Public()
  @Get('callback')
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.assertEnabled();

    const handshake = this.readHandshake(request);

    // Whatever happens next, this login is over.
    reply.clearCookie(HANDSHAKE_COOKIE, { path: '/api/auth/oidc' });

    try {
      const { principal, returnTo } = await this.oidc.completeLogin(
        { code, state, error, errorDescription },
        handshake,
      );

      const session = await this.sessions.issue(principal, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });

      const secure = this.secureCookies();

      reply.setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: '/',
        expires: session.expiresAt,
      });

      // Readable by the SPA: the double-submit CSRF pattern needs the client to
      // echo it back. Same contract as the password login path.
      reply.setCookie(CSRF_COOKIE, session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure,
        path: '/',
        expires: session.expiresAt,
      });

      this.logger.log(`SSO login for ${principal.username} (${principal.role})`);
      reply.redirect(returnTo, 302);
    } catch (caught) {
      const message = (caught as Error).message;
      this.logger.warn(`SSO login failed: ${message}`);
      reply.redirect(`/login?error=${encodeURIComponent(message)}`, 302);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Read and validate the handshake cookie.
   *
   * Unsigning is what makes the `state` inside it trustworthy — an unsigned
   * cookie could be written by anyone able to run script on the origin, which
   * would defeat the CSRF protection the state exists to provide.
   */
  private readHandshake(request: FastifyRequest): LoginHandshake | null {
    const raw = request.cookies?.[HANDSHAKE_COOKIE];
    if (!raw) return null;

    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;

    try {
      const parsed = JSON.parse(unsigned.value) as Partial<LoginHandshake>;
      if (
        typeof parsed.state !== 'string' ||
        typeof parsed.nonce !== 'string' ||
        typeof parsed.verifier !== 'string' ||
        typeof parsed.issuedAt !== 'number'
      ) {
        return null;
      }
      return {
        state: parsed.state,
        nonce: parsed.nonce,
        verifier: parsed.verifier,
        returnTo: typeof parsed.returnTo === 'string' ? parsed.returnTo : '/',
        issuedAt: parsed.issuedAt,
      };
    } catch {
      return null;
    }
  }

  private assertEnabled(): void {
    if (!this.oidc.enabled) {
      // Not "forbidden": on a deployment without SSO configured this endpoint
      // may as well not exist.
      throw new NotFoundException('Single sign-on is not configured on this deployment.');
    }
  }

  private secureCookies(): boolean {
    return this.config.get<string>('APP_URL', '').startsWith('https://');
  }
}
