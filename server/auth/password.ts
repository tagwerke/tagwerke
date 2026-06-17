import { hash, verify } from '@node-rs/argon2';

// argon2id defaults are sensible for an interactive login.
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  return verify(passwordHash, plain);
}
