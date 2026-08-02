import { BadRequestException } from '@nestjs/common';

/**
 * The one place a password is judged acceptable.
 *
 * Extracted so first-run setup, a user changing their own password, and an
 * admin creating or resetting someone else's all apply the same rule. Three
 * copies would drift, and the way they drift is silent: an account created
 * through one path that the other path would have refused.
 *
 * Minimum length only, per current NIST SP 800-63B guidance. Composition rules
 * ("must contain a symbol") measurably push people toward weaker, more
 * predictable passwords, and the upper bound exists because argon2 hashing
 * cost is paid on every login attempt including the failed ones.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequestException(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}
