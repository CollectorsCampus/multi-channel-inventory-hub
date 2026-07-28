import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Encrypted store for connector credentials (TECHNICAL_DESIGN.md §5).
 *
 * Secrets never appear in `ChannelInstance.config`, never reach the UI after
 * being set, and exist in plaintext only inside a `Ctx` for the duration of one
 * connector call.
 *
 * AES-256-GCM. GCM is authenticated, so tampering with a stored row is detected
 * on decrypt rather than silently yielding garbage that gets sent to a
 * platform as a credential.
 *
 * The credential's `ref` is bound in as additional authenticated data. Without
 * that, anyone able to write to the database could copy one channel's
 * ciphertext onto another channel's row and make the app authenticate to
 * platform B using platform A's key — the bytes would decrypt perfectly,
 * because nothing would tie them to where they were stored.
 */

/** 96 bits, the size GCM is specified around. */
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

/**
 * Which master key encrypted a given row. Rotation writes new rows at a higher
 * version while old ones stay readable, so re-encryption never has to be a
 * single atomic step.
 */
const CURRENT_KEY_VERSION = 1;

export type SecretBundle = Record<string, string>;

@Injectable()
export class CredentialStore {
  private readonly masterKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Validated at boot by config/env.ts, which rejects anything that is not
    // exactly 32 base64-encoded bytes.
    this.masterKey = Buffer.from(config.getOrThrow<string>('CREDENTIAL_MASTER_KEY'), 'base64');
  }

  /** Create or replace the secrets stored under `ref`. */
  async put(ref: string, secrets: SecretBundle): Promise<void> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    cipher.setAAD(Buffer.from(ref, 'utf8'));

    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), 'utf8'),
      cipher.final(),
    ]);

    const data = {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: CURRENT_KEY_VERSION,
    };

    await this.prisma.credential.upsert({
      where: { ref },
      update: data,
      create: { ref, ...data },
    });
  }

  /**
   * Decrypt the secrets stored under `ref`.
   *
   * Throws on a missing row, and on any authentication failure. A failure here
   * means the row was tampered with, moved from another ref, or encrypted under
   * a master key we no longer hold — none of which should ever be papered over
   * by returning empty secrets, because that would surface later as a confusing
   * authentication error against the platform.
   */
  async get(ref: string): Promise<SecretBundle> {
    const record = await this.prisma.credential.findUnique({ where: { ref } });
    if (!record) throw new NotFoundException(`No credentials stored for "${ref}".`);

    if (record.keyVersion !== CURRENT_KEY_VERSION) {
      throw new InternalServerErrorException(
        `Credential "${ref}" was encrypted with master key version ${record.keyVersion}, ` +
          `but this server only holds version ${CURRENT_KEY_VERSION}.`,
      );
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.masterKey,
        Buffer.from(record.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(ref, 'utf8'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]);

      return JSON.parse(plaintext.toString('utf8')) as SecretBundle;
    } catch {
      // Deliberately opaque: the underlying error can distinguish a bad auth
      // tag from malformed base64, which is more than a caller needs to know.
      throw new InternalServerErrorException(
        `Credentials for "${ref}" could not be decrypted. The record may have been altered, ` +
          `or CREDENTIAL_MASTER_KEY may have changed since it was written.`,
      );
    }
  }

  async has(ref: string): Promise<boolean> {
    return (await this.prisma.credential.count({ where: { ref } })) > 0;
  }

  async delete(ref: string): Promise<void> {
    await this.prisma.credential.deleteMany({ where: { ref } });
  }

  /** Generate a ref for a new channel. Opaque by design; never derived from secrets. */
  static newRef(connectorKey: string): string {
    return `${connectorKey}:${randomBytes(12).toString('hex')}`;
  }
}
