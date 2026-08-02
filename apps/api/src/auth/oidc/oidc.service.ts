import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { UserRole } from '@hub/db';
import { PrismaService } from '../../prisma/prisma.service';
import { parseAllowedOrigins, parseRoleMap } from '../../config/env';
import { fetchDiscovery, type FetchLike, type OidcDiscovery } from './discovery';
import { createPkcePair, randomToken, safeEqual } from './pkce';
import type { AuthenticatedPrincipal } from '../auth-provider.interface';

/**
 * Generic OpenID Connect, authorization code flow with PKCE (§8).
 *
 * Generic on purpose: discovery plus the standard code flow works with
 * Keycloak, Auth0, Entra, Google and anything else that implements the
 * specification, which is worth far more to a self-hoster than per-vendor
 * integrations would be.
 *
 * ## What is hand-written and what is not
 *
 * Discovery, the authorization redirect and the code exchange are ordinary HTTP
 * and live here, where their security properties can be read. **ID token
 * verification is not hand-written** — it goes through `jose`, because
 * verifying a JWT signature against a rotating JWKS is where hand-rolled OIDC
 * implementations fail, and they fail silently: `alg: none`, RS256/HS256
 * confusion, an unchecked `kid`, a JWKS cache that never rotates. `jose` is
 * given an explicit algorithm allow-list, the expected issuer and audience, and
 * a clock tolerance, and everything it cannot check — the nonce — is checked
 * immediately after.
 *
 * ## Roles
 *
 * With `OIDC_ROLE_CLAIM` set the identity provider is authoritative and the
 * mapped role is reapplied on **every** login, so removing someone from a group
 * there takes effect here at once. Without it, a user is created with
 * `OIDC_DEFAULT_ROLE` and their role is managed locally thereafter — the
 * difference matters, and silently picking one would surprise somebody.
 */

/** Asymmetric only. HS256 with a shared secret is not how ID tokens are signed. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256'];

/** A login has to complete inside this, which also bounds how long a state is replayable. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Discovery is re-fetched this often; JWKS rotation is handled by jose itself. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Carried in the browser's signed cookie for the length of one login. */
export interface LoginHandshake {
  state: string;
  nonce: string;
  verifier: string;
  /** Where to send the browser once the session exists. */
  returnTo: string;
  issuedAt: number;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  roleClaim?: string;
  roleMap: Record<string, UserRole>;
  defaultRole: UserRole;
  allowLocalLogin: boolean;
  /** Extra origins this issuer's endpoints may live on. Usually empty. */
  allowedEndpointOrigins: string[];
}

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);

  private discovery?: { value: OidcDiscovery; fetchedAt: number };
  private jwks?: { uri: string; getKey: JWTVerifyGetKey };

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    /**
     * The single network seam — discovery, the token exchange and the JWKS all
     * go through it, so a test can stand up a whole identity provider.
     *
     * `@Optional()` is load-bearing, not decoration: NestJS resolves
     * constructor parameters from `design:paramtypes` at runtime, and a default
     * value does not stop it trying to find a provider for `Function`. Without
     * this the container fails to build — which is a boot failure, not a
     * typecheck one, and is why `app.module.spec.ts` exists.
     */
    @Optional() private readonly doFetch: FetchLike = (url, init) => fetch(url, init),
  ) {}

  get enabled(): boolean {
    return this.config.get<string>('AUTH_PROVIDER') === 'oidc';
  }

  settings(): OidcSettings {
    return {
      issuer: this.config.getOrThrow<string>('OIDC_ISSUER_URL'),
      clientId: this.config.getOrThrow<string>('OIDC_CLIENT_ID'),
      clientSecret: this.config.getOrThrow<string>('OIDC_CLIENT_SECRET'),
      scopes: this.config.get<string>('OIDC_SCOPES', 'openid profile email'),
      roleClaim: this.config.get<string>('OIDC_ROLE_CLAIM'),
      roleMap: parseRoleMap(this.config.get<string>('OIDC_ROLE_MAP')),
      defaultRole: this.config.get<UserRole>('OIDC_DEFAULT_ROLE', 'viewer'),
      allowLocalLogin: this.config.get<boolean>('OIDC_ALLOW_LOCAL_LOGIN') !== false,
      allowedEndpointOrigins: parseAllowedOrigins(
        this.config.get<string>('OIDC_ALLOWED_ENDPOINT_ORIGINS'),
      ),
    };
  }

  /** The redirect URI registered with the provider. Derived, never configured twice. */
  redirectUri(): string {
    const appUrl = this.config.getOrThrow<string>('APP_URL').replace(/\/$/, '');
    return `${appUrl}/api/auth/oidc/callback`;
  }

  // -------------------------------------------------------------------------
  // Step 1: send the browser to the provider
  // -------------------------------------------------------------------------

  /**
   * Build the authorization URL and the handshake that must be stored with the
   * browser to complete it.
   *
   * The handshake is returned rather than stored server-side on purpose: keeping
   * it in a short-lived signed cookie means several API replicas need no shared
   * state to finish a login one of the others started.
   */
  async beginLogin(returnTo: string): Promise<{ url: string; handshake: LoginHandshake }> {
    const settings = this.settings();
    const discovery = await this.discover();
    const pkce = createPkcePair();

    const handshake: LoginHandshake = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: pkce.verifier,
      returnTo: safeReturnTo(returnTo),
      issuedAt: Date.now(),
    };

    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', settings.scopes);
    url.searchParams.set('state', handshake.state);
    url.searchParams.set('nonce', handshake.nonce);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);

    return { url: url.toString(), handshake };
  }

  // -------------------------------------------------------------------------
  // Step 2: the browser comes back with a code
  // -------------------------------------------------------------------------

  /**
   * Complete a login: verify the callback belongs to this browser, redeem the
   * code, verify the ID token, and resolve it to a principal.
   */
  async completeLogin(
    params: { code?: string; state?: string; error?: string; errorDescription?: string },
    handshake: LoginHandshake | null,
  ): Promise<{ principal: AuthenticatedPrincipal; returnTo: string }> {
    // The provider itself refused — the user cancelled, or consent was denied.
    // Their wording is more useful than anything we could invent.
    if (params.error) {
      throw new UnauthorizedException(
        `The identity provider refused the login: ${params.errorDescription ?? params.error}`,
      );
    }

    if (!handshake) {
      throw new BadRequestException(
        'No login is in progress in this browser. Start again from the sign-in page.',
      );
    }
    if (Date.now() - handshake.issuedAt > LOGIN_TIMEOUT_MS) {
      throw new BadRequestException('This login took too long. Start again.');
    }

    // The check that makes the callback trustworthy: without it, an attacker
    // can hand a victim's browser their own authorization code and have the
    // victim silently signed in as the attacker.
    if (!safeEqual(params.state, handshake.state)) {
      throw new UnauthorizedException('This sign-in response does not match the request.');
    }
    if (!params.code) {
      throw new BadRequestException('The identity provider returned no authorization code.');
    }

    const tokens = await this.exchangeCode(params.code, handshake.verifier);
    const claims = await this.verifyIdToken(tokens.id_token, handshake.nonce);
    const principal = await this.resolveUser(claims);

    return { principal, returnTo: handshake.returnTo };
  }

  /**
   * Redeem the authorization code.
   *
   * The client secret goes in the POST body rather than a Basic header: both
   * are permitted, and every provider supports `client_secret_post`, whereas
   * choosing between them from discovery metadata is a needless branch.
   */
  private async exchangeCode(code: string, verifier: string): Promise<{ id_token: string }> {
    const settings = this.settings();
    const discovery = await this.discover();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code_verifier: verifier,
    });

    const response = await this.doFetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      id_token?: unknown;
      error?: unknown;
      error_description?: unknown;
    };

    if (!response.ok) {
      // Logged with detail, returned without: a token endpoint error can echo
      // parts of the request, and this response goes to a browser.
      this.logger.warn(
        `Token exchange failed (HTTP ${response.status}): ${String(payload.error ?? '')} ` +
          `${String(payload.error_description ?? '')}`,
      );
      throw new UnauthorizedException('The identity provider rejected this sign-in.');
    }

    if (typeof payload.id_token !== 'string') {
      throw new UnauthorizedException(
        'The identity provider returned no ID token. Check that the "openid" scope is granted.',
      );
    }

    return { id_token: payload.id_token };
  }

  /**
   * Verify the ID token's signature and claims.
   *
   * Everything structural is delegated to `jose` with an explicit allow-list —
   * an unconstrained `algorithms` is how `alg: none` and RS256/HS256 confusion
   * get in. The nonce is checked here because it is the one claim `jose` cannot
   * know about, and skipping it would leave a token from a different login
   * perfectly acceptable.
   */
  private async verifyIdToken(idToken: string, expectedNonce: string): Promise<JWTPayload> {
    const settings = this.settings();
    const discovery = await this.discover();

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, await this.keyStore(discovery.jwksUri), {
        issuer: discovery.issuer,
        audience: settings.clientId,
        algorithms: allowedAlgorithms(discovery),
        // Tolerates ordinary clock skew between two servers; anything larger is
        // a misconfiguration worth failing on.
        clockTolerance: 60,
      }));
    } catch (error) {
      this.logger.warn(`ID token rejected: ${(error as Error).message}`);
      throw new UnauthorizedException('The identity provider returned a token we cannot trust.');
    }

    if (!safeEqual(typeof payload.nonce === 'string' ? payload.nonce : undefined, expectedNonce)) {
      this.logger.warn('ID token nonce did not match the login it was issued for.');
      throw new UnauthorizedException('The identity provider returned a token we cannot trust.');
    }

    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new UnauthorizedException('The ID token carries no subject claim.');
    }

    return payload;
  }

  // -------------------------------------------------------------------------
  // Step 3: turn verified claims into a user
  // -------------------------------------------------------------------------

  /**
   * Find or create the user behind a verified token.
   *
   * Keyed on `(provider, externalId)` from the `sub` claim, never on email:
   * email addresses get reassigned between people, and matching on one would
   * hand a new employee the previous holder's access. `sub` is the only claim
   * an identity provider promises is stable and unique.
   */
  private async resolveUser(claims: JWTPayload): Promise<AuthenticatedPrincipal> {
    const subject = claims.sub!;
    const email = typeof claims.email === 'string' ? claims.email : null;
    const username = pickUsername(claims);
    const displayName = typeof claims.name === 'string' ? claims.name : null;

    const existing = await this.prisma.user.findUnique({
      where: { provider_externalId: { provider: 'oidc', externalId: subject } },
    });

    const settings = this.settings();
    const mappedRole = this.roleFromClaims(claims);

    if (existing) {
      if (!existing.isActive) {
        throw new UnauthorizedException('This account has been deactivated.');
      }

      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          lastLoginAt: new Date(),
          ...(email !== null ? { email } : {}),
          ...(displayName !== null ? { displayName } : {}),
          // Only when a claim is configured. Otherwise the local role stands,
          // and overwriting it here would silently undo an operator's decision.
          ...(mappedRole ? { role: mappedRole } : {}),
        },
      });

      return { userId: updated.id, username: updated.username, role: updated.role as UserRole };
    }

    /**
     * Bootstrap. With no users at all there is nobody who could have granted a
     * role, and an SSO-only deployment would otherwise have no way in — the
     * same reasoning as the first-run local admin.
     */
    const isFirstUser = (await this.prisma.user.count()) === 0;
    const role: UserRole = isFirstUser ? 'admin' : (mappedRole ?? settings.defaultRole);

    if (isFirstUser) {
      this.logger.warn(
        `Provisioning "${username}" as the first user, with the admin role. ` +
          `Subsequent sign-ins receive ${mappedRole ? 'their mapped role' : settings.defaultRole}.`,
      );
    }

    const created = await this.prisma.user.create({
      data: {
        username: await this.uniqueUsername(username),
        email,
        displayName,
        provider: 'oidc',
        externalId: subject,
        role,
        // Null by design: an SSO user has no password here, and the change
        // password path already refuses an account without one.
        passwordHash: null,
        lastLoginAt: new Date(),
      },
    });

    return { userId: created.id, username: created.username, role: created.role as UserRole };
  }

  /**
   * Map the configured claim onto a role.
   *
   * Undefined means "no claim configured", which is different from "configured
   * but matched nothing" — the caller uses the distinction to decide whether to
   * overwrite an existing role.
   */
  private roleFromClaims(claims: JWTPayload): UserRole | undefined {
    const settings = this.settings();
    if (!settings.roleClaim) return undefined;

    const raw = claims[settings.roleClaim];
    const values = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string')
      : typeof raw === 'string'
        ? // Some providers send a space- or comma-separated string.
          raw.split(/[\s,]+/).filter(Boolean)
        : [];

    // Most privileged wins when a user is in several mapped groups. The reverse
    // would mean adding somebody to a second group could demote them.
    const ranked: UserRole[] = ['admin', 'editor', 'viewer'];
    for (const role of ranked) {
      if (values.some((value) => settings.roleMap[value] === role)) return role;
    }

    return settings.defaultRole;
  }

  /** Usernames are unique; a collision with an existing account gets a suffix. */
  private async uniqueUsername(preferred: string): Promise<string> {
    const base = preferred.slice(0, 60);

    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!taken) return candidate;
    }

    return `${base}-${randomToken().slice(0, 8)}`;
  }

  // -------------------------------------------------------------------------

  /** Discovery, cached. Refetched hourly so a rotated endpoint is picked up. */
  private async discover(): Promise<OidcDiscovery> {
    const fresh = this.discovery && Date.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS;
    if (this.discovery && fresh) return this.discovery.value;

    const value = await fetchDiscovery(
      this.settings().issuer,
      this.doFetch,
      undefined,
      this.settings().allowedEndpointOrigins,
    );
    this.discovery = { value, fetchedAt: Date.now() };
    return value;
  }

  /**
   * The JWKS, held across logins.
   *
   * `createRemoteJWKSet` does the part that is easy to get wrong by hand:
   * caching keys, refetching when an unknown `kid` appears, and rate-limiting
   * that refetch so an attacker cannot use bogus key ids to make us hammer the
   * provider.
   */
  private async keyStore(jwksUri: string): Promise<JWTVerifyGetKey> {
    if (this.jwks?.uri === jwksUri) return this.jwks.getKey;

    const getKey = createRemoteJWKSet(new URL(jwksUri), {
      // Routed through the same injected fetch as discovery and the token
      // exchange. Left on global fetch this would be a second network seam that
      // no test could reach — and the JWKS is the one input that decides
      // whether a token is genuine.
      [customFetch]: (url: string, options?: RequestInit) => this.doFetch(url, options),
    });

    this.jwks = { uri: jwksUri, getKey };
    return getKey;
  }
}

/**
 * Intersect our allow-list with what the provider advertises.
 *
 * Narrowing to what an issuer actually signs with means a downgrade to another
 * algorithm it also supports is refused, and the list can never widen beyond
 * the asymmetric set above.
 */
function allowedAlgorithms(discovery: OidcDiscovery): string[] {
  const advertised = discovery.idTokenSigningAlgValuesSupported;
  if (!advertised || advertised.length === 0) return ALLOWED_ALGORITHMS;

  const intersection = ALLOWED_ALGORITHMS.filter((alg) => advertised.includes(alg));
  return intersection.length > 0 ? intersection : ALLOWED_ALGORITHMS;
}

/** A readable username from whichever claims the provider chose to send. */
function pickUsername(claims: JWTPayload): string {
  for (const key of ['preferred_username', 'email', 'name'] as const) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return `oidc-${String(claims.sub).slice(0, 12)}`;
}

/**
 * Confine the post-login redirect to this application.
 *
 * `returnTo` arrives as a query parameter, so without this the sign-in link is
 * an open redirect — and an open redirect on a login endpoint is the classic
 * way to make a phishing URL that genuinely starts on the victim's own domain.
 */
export function safeReturnTo(value: string | undefined): string {
  if (!value) return '/';
  // Must be a single-slash absolute path. `//evil.example` and `https://…` are
  // both absolute URLs to a browser.
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (/[\r\n]/.test(value)) return '/';
  return value;
}
