import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type UserRole } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { assertPasswordAcceptable } from '../auth/password-policy';

/**
 * User administration (§8).
 *
 * Everything here is admin-only and the guards enforce that; what this file is
 * actually about is the two ways an administrator can destroy their own access
 * with one well-meaning click, and refusing both.
 *
 * ## Nobody can lock themselves out, and nobody can lock everybody out
 *
 * 1. **You cannot demote, deactivate or delete yourself.** The mistake is easy
 *    — tidying up a user list and not noticing whose row it is — and the
 *    consequence is an instance you can no longer administer even though your
 *    password still works.
 * 2. **The last active admin is untouchable**, by anyone including a different
 *    admin. Two admins each demoting the other in sequence is a perfectly
 *    ordinary sequence of legal-looking requests that ends with nobody able to
 *    connect a channel or add a user.
 *
 * Neither is a permission check, which is why neither belongs in a guard: the
 * caller is authorised, the *outcome* is what is refused. Both are also
 * deliberately refused rather than warned about — there is no undo, and the
 * only recovery is a database edit.
 *
 * ## Local passwords never touch a provisioned identity
 *
 * A user whose `provider` is `oidc` has no password and must not be given one.
 * `LocalAuthProvider` already refuses to authenticate them, so a password set
 * here would be a credential that looks real and can never be used — or worse,
 * a second door into an SSO identity if that refusal ever softened.
 */

/** What the API reports about a user. Never a hash, never a token. */
export interface UserSummary {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  provider: string;
  isActive: boolean;
  /** True when this account can sign in with a password. */
  hasPassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  email?: string;
  displayName?: string;
}

export interface UpdateUserInput {
  role?: UserRole;
  isActive?: boolean;
  email?: string | null;
  displayName?: string | null;
}

const SELECT = {
  id: true,
  username: true,
  email: true,
  displayName: true,
  role: true,
  provider: true,
  isActive: true,
  passwordHash: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

type UserRow = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  provider: string;
  isActive: boolean;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async list(): Promise<UserSummary[]> {
    const users = await this.prisma.user.findMany({
      select: SELECT,
      orderBy: [{ isActive: 'desc' }, { username: 'asc' }],
    });

    return users.map(toSummary);
  }

  async create(input: CreateUserInput): Promise<UserSummary> {
    const username = input.username.trim();
    if (username === '') throw new BadRequestException('A username is required.');

    assertPasswordAcceptable(input.password);

    try {
      const user = await this.prisma.user.create({
        data: {
          username,
          passwordHash: await this.passwords.hash(input.password),
          role: input.role,
          // Always local. An account created here is one someone signs into
          // with a password, and claiming a `provider` the identity did not
          // come from would make `@@unique([provider, externalId])` meaningless.
          provider: 'local',
          ...(input.email ? { email: input.email.trim() } : {}),
          ...(input.displayName ? { displayName: input.displayName.trim() } : {}),
        },
        select: SELECT,
      });

      this.logger.log(`Created user "${username}" (${input.role})`);
      return toSummary(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // `username` and `email` are both unique; naming the field is the
        // difference between a fixable message and a puzzle.
        const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
        throw new ConflictException(`That ${target} is already taken.`);
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateUserInput, actorUserId: string): Promise<UserSummary> {
    const user = await this.require(id);

    if (input.role !== undefined && input.role !== user.role) {
      await this.assertNotSelfSabotage(user, actorUserId, 'change your own role');
      if (user.role === 'admin') await this.assertNotLastAdmin(user, 'demoted');
    }

    if (input.isActive === false && user.isActive) {
      await this.assertNotSelfSabotage(user, actorUserId, 'deactivate your own account');
      if (user.role === 'admin') await this.assertNotLastAdmin(user, 'deactivated');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
        ...(input.displayName !== undefined
          ? { displayName: input.displayName?.trim() || null }
          : {}),
      },
      select: SELECT,
    });

    // Deactivation takes effect on the very next request without any session
    // sweep: `SessionService.resolve` and `ApiKeyService.resolve` both check
    // `isActive` on the joined user. Revoking here as well would be belt and
    // braces over a check that is already load-bearing.
    return toSummary(updated);
  }

  /**
   * Set someone's password as an administrator.
   *
   * Separate from `AuthService.changePassword`, which demands the *current*
   * password and is how a person changes their own. An admin does not know it
   * and should not need to — this exists for the person who is locked out.
   */
  async setPassword(id: string, password: string): Promise<void> {
    const user = await this.require(id);

    if (user.provider !== 'local') {
      throw new BadRequestException(
        `"${user.username}" signs in through ${user.provider}, so a password here would never ` +
          `be used. Manage that account with your identity provider.`,
      );
    }

    assertPasswordAcceptable(password);

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await this.passwords.hash(password) },
    });

    // Every existing session is cut, exactly as changing your own password
    // does. An admin resetting a password is most often responding to it being
    // compromised, and leaving the attacker's session alive would defeat it.
    await this.prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.logger.log(`Password reset for "${user.username}"`);
  }

  async remove(id: string, actorUserId: string): Promise<void> {
    const user = await this.require(id);

    await this.assertNotSelfSabotage(user, actorUserId, 'delete your own account');
    if (user.role === 'admin') await this.assertNotLastAdmin(user, 'deleted');

    // Sessions and API keys cascade from the schema, so deletion really does
    // end the account rather than leaving usable credentials behind.
    await this.prisma.user.delete({ where: { id } });
    this.logger.log(`Deleted user "${user.username}"`);
  }

  // ---------------------------------------------------------------------------

  private async require(id: string): Promise<UserRow> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SELECT });
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    return user;
  }

  private async assertNotSelfSabotage(
    user: UserRow,
    actorUserId: string,
    what: string,
  ): Promise<void> {
    if (user.id === actorUserId) {
      throw new BadRequestException(
        `You cannot ${what}. Ask another admin to do it, so the instance is never left ` +
          `without one by accident.`,
      );
    }
  }

  private async assertNotLastAdmin(user: UserRow, verb: string): Promise<void> {
    const admins = await this.prisma.user.count({ where: { role: 'admin', isActive: true } });

    // Counted rather than assumed, and counted at the moment of the change:
    // two admins demoting each other in sequence is otherwise a pair of
    // perfectly legal requests that ends with nobody in charge.
    if (admins <= 1 && user.isActive) {
      throw new BadRequestException(
        `"${user.username}" is the only active admin and cannot be ${verb}. Promote someone ` +
          `else first, or nobody will be able to administer this instance.`,
      );
    }
  }
}

function toSummary(user: UserRow): UserSummary {
  const { passwordHash, ...rest } = user;
  return {
    ...rest,
    role: rest.role as UserRole,
    // Whether a password exists is worth reporting — it is the difference
    // between an account that can use the break-glass login and one that
    // cannot. The hash itself never leaves this function.
    hasPassword: passwordHash !== null,
  };
}
