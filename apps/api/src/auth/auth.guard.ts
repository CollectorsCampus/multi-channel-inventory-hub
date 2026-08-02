import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { roleAtLeast, type UserRole } from '@hub/db';
import { ApiKeyService } from './api-key.service';
import { CSRF_HEADER, SESSION_COOKIE, SessionService } from './session.service';
import { IS_PUBLIC_KEY, REQUIRED_ROLE_KEY } from './decorators';
import type { AuthenticatedPrincipal } from './auth-provider.interface';

/** Methods that mutate state and therefore require a CSRF token. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
    /**
     * The CSRF token of the session that authenticated this request.
     *
     * Attached so `/auth/me` can re-issue the readable cookie and heal a
     * browser whose cookie has drifted from its session. Absent for a Bearer
     * key, which carries no cookie and needs no token.
     */
    sessionCsrfToken?: string;
  }
}

/**
 * Registered globally, so routes are authenticated unless explicitly `@Public()`.
 *
 * Accepts either a session cookie (browser) or a bearer API key (automation).
 * CSRF is enforced here rather than in a separate guard because the expected
 * token lives on the session row we just loaded — splitting it out would mean a
 * second lookup of the same record.
 *
 * The UI only reflects permissions; this guard is where they are enforced
 * (TECHNICAL_DESIGN.md §8).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = await this.authenticate(request);

    if (!principal) throw new UnauthorizedException('Authentication required');
    request.principal = principal;

    const requiredRole = this.reflector.getAllAndOverride<UserRole>(REQUIRED_ROLE_KEY, targets);
    if (requiredRole && !roleAtLeast(principal.role, requiredRole)) {
      throw new ForbiddenException(`Requires the ${requiredRole} role or higher`);
    }

    return true;
  }

  private async authenticate(request: FastifyRequest): Promise<AuthenticatedPrincipal | null> {
    const authorization = request.headers.authorization;

    // Bearer API keys are stateless and not cookie-borne, so CSRF does not
    // apply to them — there is no ambient credential for a browser to replay.
    if (authorization?.startsWith('Bearer ')) {
      return this.apiKeys.resolve(authorization.slice('Bearer '.length).trim());
    }

    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return null;

    const resolved = await this.sessions.resolve(token);
    if (!resolved) return null;

    request.sessionCsrfToken = resolved.csrfToken;

    if (UNSAFE_METHODS.has(request.method)) {
      const presented = request.headers[CSRF_HEADER];
      const value = Array.isArray(presented) ? presented[0] : presented;
      if (!SessionService.csrfMatches(resolved.csrfToken, value)) {
        throw new ForbiddenException(
          'Missing or invalid CSRF token. Reload the page — the browser will pick up a fresh ' +
            'one — and sign in again if that does not help.',
        );
      }
    }

    return resolved.principal;
  }
}
