import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUserRole, type UserRole } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedPrincipal } from './auth-provider.interface';

export const SESSION_COOKIE = 'hub_session';
export const CSRF_COOKIE = 'hub_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface IssuedSession {
  /** Raw token — goes in the cookie and is never persisted. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Session tokens are stored as SHA-256, not argon2. They are 256 bits of
   * CSPRNG output rather than user-chosen secrets, so there is no brute-force
   * margin for a slow hash to protect; a fast digest keeps per-request lookup
   * to a single indexed read.
   */
  private static digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issue(
    principal: AuthenticatedPrincipal,
    context: { userAgent?: string; ipAddress?: string } = {},
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const ttlHours = this.config.get<number>('SESSION_TTL_HOURS', 720);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    await this.prisma.session.create({
      data: {
        userId: principal.userId,
        tokenHash: SessionService.digest(token),
        csrfToken,
        userAgent: context.userAgent?.slice(0, 512) ?? null,
        ipAddress: context.ipAddress ?? null,
        expiresAt,
      },
    });

    return { token, csrfToken, expiresAt };
  }

  /** Resolve a raw cookie token to a principal, or null if unusable. */
  async resolve(
    token: string,
  ): Promise<{ principal: AuthenticatedPrincipal; csrfToken: string } | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: SessionService.digest(token) },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
    if (!session.user.isActive) return null;

    // Best-effort activity tracking; a failure here must not fail the request.
    void this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    return {
      principal: {
        userId: session.user.id,
        username: session.user.username,
        role: isUserRole(session.user.role) ? session.user.role : ('viewer' as UserRole),
      },
      csrfToken: session.csrfToken,
    };
  }

  async revoke(token: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: SessionService.digest(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Delete expired/revoked rows. Called by a scheduled job. */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }] },
    });
    return count;
  }

  /** Constant-time CSRF token comparison. */
  static csrfMatches(expected: string, provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
