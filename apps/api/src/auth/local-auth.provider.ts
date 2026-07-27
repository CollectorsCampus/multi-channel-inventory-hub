import { Injectable } from '@nestjs/common';
import { isUserRole, type UserRole } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import type {
  AuthProvider,
  AuthenticatedPrincipal,
  CredentialsPayload,
} from './auth-provider.interface';

/** A real argon2id hash of a random string, used as a timing decoy. */
let dummyHashPromise: Promise<string> | null = null;

@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly key = 'local';
  readonly displayName = 'Username & password';
  readonly supportsDirectLogin = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async authenticate(credentials: CredentialsPayload): Promise<AuthenticatedPrincipal | null> {
    const user = await this.prisma.user.findUnique({
      where: { username: credentials.username },
    });

    // Always run a verification, even when the user does not exist or has no
    // local password, so response time does not disclose which case occurred.
    if (!user?.passwordHash || !user.isActive || user.provider !== this.key) {
      await this.passwords.verify(await this.dummyHash(), credentials.password);
      return null;
    }

    const ok = await this.passwords.verify(user.passwordHash, credentials.password);
    if (!ok) return null;

    // A role that fell outside the known set (hand-edited row, botched
    // migration) must fail closed rather than being trusted.
    const role: UserRole = isUserRole(user.role) ? user.role : 'viewer';

    return { userId: user.id, username: user.username, role };
  }

  private dummyHash(): Promise<string> {
    dummyHashPromise ??= this.passwords.hash('invalid-password-placeholder');
    return dummyHashPromise;
  }
}
