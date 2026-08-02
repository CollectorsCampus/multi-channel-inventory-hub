import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { UsersService } from './users.service';
import { PasswordService } from '../auth/password.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * User administration, against a real database.
 *
 * The properties worth pinning are all about **not being able to lock everyone
 * out**, and none of them is observable without the rows: they depend on
 * counting the admins that actually exist at the moment of the change.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

let prisma: PrismaClient;
let users: UsersService;

const GOOD_PASSWORD = 'correct horse battery staple';

async function seed(
  username: string,
  role: string,
  extra: { isActive?: boolean; provider?: string } = {},
) {
  return prisma.user.create({
    data: {
      username,
      role,
      provider: extra.provider ?? 'local',
      passwordHash: extra.provider === 'oidc' ? null : 'x',
      ...(extra.provider === 'oidc' ? { externalId: `sub-${username}` } : {}),
      isActive: extra.isActive ?? true,
    },
  });
}

describeDb('UsersService', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    users = new UsersService(prisma as unknown as PrismaService, new PasswordService());
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.user.deleteMany();
  });

  describe('creating', () => {
    it('creates a local account and never reports the hash', async () => {
      const created = await users.create({
        username: 'jsmith',
        password: GOOD_PASSWORD,
        role: 'editor',
      });

      expect(created).toMatchObject({
        username: 'jsmith',
        role: 'editor',
        provider: 'local',
        isActive: true,
        hasPassword: true,
      });
      expect(created).not.toHaveProperty('passwordHash');

      // Stored hashed, not stored at all in plaintext.
      const row = await prisma.user.findUnique({ where: { username: 'jsmith' } });
      expect(row!.passwordHash).not.toBe(GOOD_PASSWORD);
      expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('applies the shared password policy', async () => {
      await expect(
        users.create({ username: 'shorty', password: 'short', role: 'viewer' }),
      ).rejects.toThrow(/at least 12/);
    });

    it('names the field that collided', async () => {
      await seed('taken', 'viewer');

      await expect(
        users.create({ username: 'taken', password: GOOD_PASSWORD, role: 'viewer' }),
      ).rejects.toThrow(/username is already taken/i);
    });
  });

  /**
   * The heart of it. Every one of these is a request an authorised admin is
   * allowed to make, refused because of what it would *leave behind*.
   */
  describe('never leaves the instance without an admin', () => {
    it('refuses to let an admin demote themselves', async () => {
      const me = await seed('me', 'admin');
      await seed('other', 'admin');

      await expect(users.update(me.id, { role: 'viewer' }, me.id)).rejects.toThrow(
        /cannot change your own role/i,
      );
      expect((await prisma.user.findUnique({ where: { id: me.id } }))!.role).toBe('admin');
    });

    it('refuses to let an admin deactivate or delete themselves', async () => {
      const me = await seed('me', 'admin');
      await seed('other', 'admin');

      await expect(users.update(me.id, { isActive: false }, me.id)).rejects.toThrow(
        /cannot deactivate your own account/i,
      );
      await expect(users.remove(me.id, me.id)).rejects.toThrow(/cannot delete your own account/i);
      expect(await prisma.user.count()).toBe(2);
    });

    /**
     * Two admins demoting each other in sequence is a pair of perfectly legal
     * requests that ends with nobody in charge. The count is taken at the
     * moment of the change, which is what catches the second one.
     */
    it('refuses to demote, deactivate or delete the last active admin', async () => {
      const first = await seed('first', 'admin');
      const second = await seed('second', 'admin');

      // Legal: two admins, so one may go.
      await users.update(first.id, { role: 'viewer' }, second.id);

      await expect(users.update(second.id, { role: 'viewer' }, first.id)).rejects.toThrow(
        /only active admin/i,
      );
      await expect(users.update(second.id, { isActive: false }, first.id)).rejects.toThrow(
        /only active admin/i,
      );
      await expect(users.remove(second.id, first.id)).rejects.toThrow(/only active admin/i);
    });

    /**
     * A deactivated admin is not an admin who can do anything, so it must not
     * count towards "there is still someone in charge".
     */
    it('does not count a deactivated admin as cover for demoting the last active one', async () => {
      const active = await seed('active', 'admin');
      await seed('dormant', 'admin', { isActive: false });
      const actor = await seed('actor', 'admin');
      await users.update(actor.id, { role: 'viewer' }, active.id);

      await expect(users.update(active.id, { role: 'viewer' }, actor.id)).rejects.toThrow(
        /only active admin/i,
      );
    });

    it('allows all of it once someone else is admin', async () => {
      const me = await seed('me', 'admin');
      const helper = await seed('helper', 'viewer');

      await users.update(helper.id, { role: 'admin' }, me.id);
      const updated = await users.update(me.id, { role: 'editor' }, helper.id);

      expect(updated.role).toBe('editor');
    });

    /** Demoting a non-admin can never leave the instance uncovered. */
    it('does not obstruct ordinary role changes', async () => {
      const admin = await seed('admin', 'admin');
      const viewer = await seed('viewer', 'viewer');

      expect((await users.update(viewer.id, { role: 'editor' }, admin.id)).role).toBe('editor');
    });
  });

  describe('passwords', () => {
    it('sets one and cuts every existing session', async () => {
      const user = await seed('locked-out', 'editor');
      await prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: 'hash-1',
          csrfToken: 'csrf',
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

      await users.setPassword(user.id, GOOD_PASSWORD);

      const sessions = await prisma.session.findMany({ where: { userId: user.id } });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      expect(
        await new PasswordService().verify(
          (await prisma.user.findUnique({ where: { id: user.id } }))!.passwordHash!,
          GOOD_PASSWORD,
        ),
      ).toBe(true);
    });

    /**
     * `LocalAuthProvider` refuses any user whose provider is not local, so a
     * password here would be a credential that looks real and can never work.
     */
    it('refuses to give a provisioned identity a local password', async () => {
      const user = await seed('sso-user', 'editor', { provider: 'oidc' });

      await expect(users.setPassword(user.id, GOOD_PASSWORD)).rejects.toThrow(/signs in through/i);
      expect((await prisma.user.findUnique({ where: { id: user.id } }))!.passwordHash).toBeNull();
    });

    it('applies the same policy as everywhere else', async () => {
      const user = await seed('someone', 'editor');
      await expect(users.setPassword(user.id, 'short')).rejects.toThrow(/at least 12/);
    });
  });

  describe('listing', () => {
    it('reports whether an account can use a password, without the hash', async () => {
      await seed('local-user', 'editor');
      await seed('sso-user', 'viewer', { provider: 'oidc' });

      const listed = await users.list();

      expect(listed.find((u) => u.username === 'local-user')!.hasPassword).toBe(true);
      expect(listed.find((u) => u.username === 'sso-user')!.hasPassword).toBe(false);
      expect(listed.every((u) => !('passwordHash' in u))).toBe(true);
    });
  });
});
