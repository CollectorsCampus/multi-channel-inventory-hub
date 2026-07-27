import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { isUserRole, roleAtLeast, type UserRole } from '@hub/db';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import type { AuthenticatedPrincipal } from './auth-provider.interface';

/**
 * API keys for headless automation (TECHNICAL_DESIGN.md §8).
 *
 * Wire format: `hub_<prefix>_<secret>`. The prefix is a non-secret lookup
 * handle stored in the clear (and shown in the UI to identify a key); only the
 * secret half is hashed. That keeps verification to one indexed read plus one
 * argon2 comparison, instead of hashing against every key in the table.
 */

const KEY_NAMESPACE = 'hub';

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * Mint a key. The plaintext is returned exactly once and never stored —
   * callers must surface it to the user immediately.
   */
  async create(params: {
    name: string;
    role: UserRole;
    userId: string;
    ownerRole: UserRole;
    expiresAt?: Date;
  }): Promise<{ id: string; plaintext: string; prefix: string }> {
    if (!roleAtLeast(params.ownerRole, params.role)) {
      throw new Error('An API key cannot be granted a role above its owner.');
    }

    const prefix = randomBytes(6).toString('hex');
    const secret = randomBytes(32).toString('base64url');

    const record = await this.prisma.apiKey.create({
      data: {
        name: params.name,
        prefix,
        keyHash: await this.passwords.hash(secret),
        role: params.role,
        userId: params.userId,
        expiresAt: params.expiresAt ?? null,
      },
    });

    return { id: record.id, prefix, plaintext: `${KEY_NAMESPACE}_${prefix}_${secret}` };
  }

  /** Resolve a presented key to a principal, or null if unusable. */
  async resolve(presented: string): Promise<AuthenticatedPrincipal | null> {
    const parts = presented.split('_');
    if (parts.length !== 3 || parts[0] !== KEY_NAMESPACE) return null;

    const [, prefix, secret] = parts;
    if (!prefix || !secret) return null;

    const key = await this.prisma.apiKey.findUnique({
      where: { prefix },
      include: { user: true },
    });

    if (!key || key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt <= new Date()) return null;
    if (!(await this.passwords.verify(key.keyHash, secret))) return null;

    // A key outlives nothing: deactivating the owning user must kill it too.
    if (key.user && !key.user.isActive) return null;

    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    const role: UserRole = isUserRole(key.role) ? key.role : 'viewer';

    return {
      userId: key.userId ?? key.id,
      username: key.user?.username ?? `apikey:${key.name}`,
      role,
    };
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
