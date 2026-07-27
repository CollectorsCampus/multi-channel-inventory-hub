import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { USER_ROLES, type UserRole } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession } from './session.service';
import { AUTH_PROVIDER, type AuthProvider } from './auth-provider.interface';

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  /** True when no user exists yet, so the first-run setup flow should run. */
  async needsFirstRunSetup(): Promise<boolean> {
    return (await this.prisma.user.count()) === 0;
  }

  /**
   * Create the initial admin. Only permitted while the instance has no users —
   * otherwise this endpoint would be an unauthenticated privilege escalation.
   */
  async createFirstAdmin(username: string, password: string): Promise<void> {
    if (!(await this.needsFirstRunSetup())) {
      throw new ConflictException('Setup has already been completed.');
    }

    this.assertPasswordAcceptable(password);

    try {
      await this.prisma.user.create({
        data: {
          username,
          passwordHash: await this.passwords.hash(password),
          role: 'admin' satisfies UserRole,
          provider: 'local',
        },
      });
    } catch {
      // Two concurrent setup requests: the unique index on username decides.
      throw new ConflictException('Setup has already been completed.');
    }
  }

  async login(
    username: string,
    password: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<IssuedSession | null> {
    const principal = await this.provider.authenticate({ username, password });
    if (!principal) return null;

    await this.prisma.user.update({
      where: { id: principal.userId },
      data: { lastLoginAt: new Date() },
    });

    return this.sessions.issue(principal, context);
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    this.assertPasswordAcceptable(next);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash || !(await this.passwords.verify(user.passwordHash, current))) {
      throw new BadRequestException('Current password is incorrect.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(next) },
    });

    // A password change must invalidate every other session for that user.
    await this.sessions.revokeAllForUser(userId);
  }

  /**
   * Minimum length only, per current NIST SP 800-63B guidance: composition
   * rules ("must contain a symbol") measurably push users toward weaker,
   * more predictable passwords.
   */
  private assertPasswordAcceptable(password: string): void {
    if (password.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters.');
    }
    if (password.length > 1024) {
      throw new BadRequestException('Password must be at most 1024 characters.');
    }
  }

  static isAssignableRole(value: string): value is UserRole {
    return (USER_ROLES as readonly string[]).includes(value);
  }
}
