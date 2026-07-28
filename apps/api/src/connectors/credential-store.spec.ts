import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@hub/db';
import { ConfigService } from '@nestjs/config';
import { CredentialStore } from './credential-store.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Integration tests for the encrypted credential store.
 *
 * Run against a real database because the properties that matter are about
 * what is *persisted*: that plaintext never lands in a column, that a tampered
 * row fails closed, and that ciphertext cannot be moved between channels.
 * A mocked Prisma would assert none of that.
 *
 * Skipped without TEST_DATABASE_URL. See inventory.service.spec.ts.
 */

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const KEY_A = Buffer.alloc(32, 0xa1).toString('base64');
const KEY_B = Buffer.alloc(32, 0xb2).toString('base64');

let prisma: PrismaClient;

function storeWithKey(masterKey: string): CredentialStore {
  const config = { getOrThrow: () => masterKey } as unknown as ConfigService;
  return new CredentialStore(prisma as unknown as PrismaService, config);
}

describeDb('CredentialStore', () => {
  let store: CredentialStore;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.credential.deleteMany();
    store = storeWithKey(KEY_A);
  });

  it('round-trips a secret bundle', async () => {
    const secrets = { accessToken: 'shpat_example', webhookSecret: 'hunter2' };
    await store.put('shopify:1', secrets);
    await expect(store.get('shopify:1')).resolves.toEqual(secrets);
  });

  it('never writes plaintext to the database', async () => {
    await store.put('shopify:1', { accessToken: 'shpat_verysecret' });

    const row = await prisma.credential.findUniqueOrThrow({ where: { ref: 'shopify:1' } });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('shpat_verysecret');
    expect(serialized).not.toContain('accessToken');
    expect(row.iv).toBeTruthy();
    expect(row.authTag).toBeTruthy();
  });

  it('produces different ciphertext each time, so equal secrets are not detectable', async () => {
    await store.put('a', { token: 'same-value' });
    const first = await prisma.credential.findUniqueOrThrow({ where: { ref: 'a' } });
    await store.put('b', { token: 'same-value' });
    const second = await prisma.credential.findUniqueOrThrow({ where: { ref: 'b' } });

    // A fresh random IV per encryption is what makes this hold.
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('replaces secrets in place when re-put', async () => {
    await store.put('shopify:1', { accessToken: 'old' });
    await store.put('shopify:1', { accessToken: 'new' });

    await expect(store.get('shopify:1')).resolves.toEqual({ accessToken: 'new' });
    expect(await prisma.credential.count()).toBe(1);
  });

  it('fails closed when the stored ciphertext is altered', async () => {
    await store.put('shopify:1', { accessToken: 'secret' });

    const row = await prisma.credential.findUniqueOrThrow({ where: { ref: 'shopify:1' } });
    const bytes = Buffer.from(row.ciphertext, 'base64');
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
    await prisma.credential.update({
      where: { ref: 'shopify:1' },
      data: { ciphertext: bytes.toString('base64') },
    });

    // GCM authenticates: tampering is detected rather than yielding garbage
    // that would be sent to a platform as a credential.
    await expect(store.get('shopify:1')).rejects.toThrow(/could not be decrypted/);
  });

  it('fails closed when the auth tag is altered', async () => {
    await store.put('shopify:1', { accessToken: 'secret' });
    await prisma.credential.update({
      where: { ref: 'shopify:1' },
      data: { authTag: Buffer.alloc(16, 0).toString('base64') },
    });
    await expect(store.get('shopify:1')).rejects.toThrow(/could not be decrypted/);
  });

  /**
   * The reason `ref` is bound in as additional authenticated data. Without it,
   * anyone with database write access could move one channel's credentials onto
   * another channel and have the app authenticate to the wrong platform with
   * them — the bytes would decrypt perfectly, since nothing would tie them to
   * where they were stored.
   */
  it('refuses ciphertext copied from a different channel', async () => {
    await store.put('shopify:real', { accessToken: 'shopify-token' });
    await store.put('tcgplayer:real', { accessToken: 'tcg-token' });

    const stolen = await prisma.credential.findUniqueOrThrow({ where: { ref: 'shopify:real' } });
    await prisma.credential.update({
      where: { ref: 'tcgplayer:real' },
      data: {
        ciphertext: stolen.ciphertext,
        iv: stolen.iv,
        authTag: stolen.authTag,
      },
    });

    await expect(store.get('tcgplayer:real')).rejects.toThrow(/could not be decrypted/);
  });

  it('cannot be read with a different master key', async () => {
    await store.put('shopify:1', { accessToken: 'secret' });
    await expect(storeWithKey(KEY_B).get('shopify:1')).rejects.toThrow(
      /CREDENTIAL_MASTER_KEY may have changed/,
    );
  });

  it('reports a missing record distinctly from a broken one', async () => {
    await expect(store.get('never-stored')).rejects.toThrow(/No credentials stored/);
  });

  it('supports existence checks and deletion', async () => {
    expect(await store.has('shopify:1')).toBe(false);
    await store.put('shopify:1', { accessToken: 'x' });
    expect(await store.has('shopify:1')).toBe(true);

    await store.delete('shopify:1');
    expect(await store.has('shopify:1')).toBe(false);
    // Deleting again is not an error; callers clean up channels idempotently.
    await expect(store.delete('shopify:1')).resolves.toBeUndefined();
  });

  it('mints unique, opaque refs', () => {
    const a = CredentialStore.newRef('shopify');
    const b = CredentialStore.newRef('shopify');
    expect(a).not.toBe(b);
    expect(a.startsWith('shopify:')).toBe(true);
  });

  it('handles a large bundle and unicode values', async () => {
    const secrets = {
      token: 'x'.repeat(4096),
      note: 'clé secrète — 秘密 🔐',
    };
    await store.put('big', secrets);
    await expect(store.get('big')).resolves.toEqual(secrets);
  });
});
