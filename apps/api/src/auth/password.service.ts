import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id password hashing (TECHNICAL_DESIGN.md §8).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's argon2id baseline
 * (19 MiB memory, 2 iterations, parallelism 1). They are recorded inside the
 * PHC-format hash string, so raising them later does not invalidate existing
 * hashes — old ones keep verifying with their original parameters.
 *
 * @node-rs/argon2 is used instead of `argon2` because it ships prebuilt
 * binaries for every platform we target, including linux-musl and arm64, so
 * neither contributors on Windows nor the multi-arch image need a C toolchain.
 */

const ARGON2_OPTIONS = {
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verify a password. Never throws on a malformed stored hash — a corrupt row
   * must read as "wrong password", not as a 500 that reveals the row exists.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }
}
