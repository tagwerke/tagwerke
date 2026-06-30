// TOTP (RFC 6238) helpers for MFA. Wraps `otpauth` and keeps backup-code handling in one
// place. Backup codes are returned to the user ONCE in plaintext at enrollment and stored
// only as Argon2 hashes (password-equivalent). See AUTH_IMPLEMENTATION_PLAN.md (Slice 5).

import * as OTPAuth from 'otpauth';
import { nanoid } from 'nanoid';
import { hashPassword, verifyPassword } from '../auth/password.ts';

const ISSUER = 'do';

export function newSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function otpauthURL(email: string, secretB32: string): string {
  const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: email, secret: OTPAuth.Secret.fromBase32(secretB32) });
  return totp.toString();
}

/** True if `token` is valid for the secret (±1 step of clock skew). */
export function verifyTotp(secretB32: string, token: string): boolean {
  try {
    const totp = new OTPAuth.TOTP({ issuer: ISSUER, secret: OTPAuth.Secret.fromBase32(secretB32) });
    return totp.validate({ token, window: 1 }) !== null;
  } catch {
    return false;
  }
}

export function newBackupCodes(n = 10): string[] {
  return Array.from({ length: n }, () => nanoid(10));
}

export function hashCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => hashPassword(c)));
}

/**
 * If `plain` matches one of the stored backup-code hashes, return the REMAINING hashes
 * (that code consumed); otherwise null. Caller persists the returned array.
 */
export async function consumeBackupCode(hashes: string[] | null | undefined, plain: string): Promise<string[] | null> {
  if (!hashes?.length) return null;
  for (let i = 0; i < hashes.length; i++) {
    if (await verifyPassword(hashes[i], plain)) {
      return hashes.filter((_, j) => j !== i);
    }
  }
  return null;
}
