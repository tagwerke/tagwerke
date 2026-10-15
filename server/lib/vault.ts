// Server-side field encryption for board secrets (SECRET_LINKS_PLAN D5).
//
// AES-256-GCM under VAULT_KEY. This defends against a stolen dump, a leaked backup or read access
// to the database — NOT against someone who holds the running server's environment as well. That
// is the trade-off D5 chose on purpose (zero-knowledge would lock SSO/passkey users out), and
// docs/data-residency.md says so rather than implying otherwise.
//
// Sealed format: `v1.<kid>.<iv>.<tag>.<ciphertext>`, each part base64url. `kid` is the first 8 hex
// of SHA-256(key), so a row names the key that sealed it and rotation can find what still needs
// re-sealing (server/scripts/rotate-vault-key.ts).
//
// The AAD is the caller's context string — for an entry, `<tabId>:<entryId>:<field>`. GCM verifies
// it, so a ciphertext copied onto another entry, another field or another board fails to open
// instead of decrypting where it does not belong.
//
// Absent VAULT_KEY disables board secrets cleanly (routes answer 503), the same posture as missing
// VAPID keys disabling push: never a half-working vault.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

interface Key {
  id: string;
  bytes: Buffer;
}

/** Shortest secret string we will stretch into a key. Same bar as a SESSION_SECRET-style value. */
const MIN_SECRET_CHARS = 32;

/**
 * The 32-byte AES key for a VAULT_KEY value. Two accepted shapes:
 *
 *   • exactly 32 bytes written as hex (64 chars) or base64/base64url (43–44 chars) — used as-is;
 *   • any other random string of at least MIN_SECRET_CHARS — stretched with HKDF-SHA256, so an
 *     operator can use the same kind of value they already put in SESSION_SECRET.
 *
 * The raw-key patterns are STRICT on purpose: Buffer.from(s, 'base64') silently skips characters
 * it does not know, and a lenient check would decide by accident which of the two paths a string
 * takes. Either way the mapping is deterministic, so a key keeps opening what it sealed.
 *
 * HKDF is right for a long random string, not for a human password — hence the length floor.
 */
function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(s) || /^[A-Za-z0-9_-]{43}$/.test(s)) {
    const bytes = Buffer.from(s, s.includes('-') || s.includes('_') ? 'base64url' : 'base64');
    if (bytes.length === 32) return bytes;
  }
  if (s.length < MIN_SECRET_CHARS) return null;
  return Buffer.from(hkdfSync('sha256', Buffer.from(s, 'utf8'), 'tagwerke-vault', 'aes-256-gcm v1', 32));
}

function keyFrom(raw: string): Key | null {
  const bytes = parseKey(raw);
  if (!bytes) return null;
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes };
}

// Read once per call, not cached at import: the verify script and the rotation script both set the
// environment after this module has loaded.
function keys(): { current: Key | null; all: Map<string, Key>; problem?: string } {
  const all = new Map<string, Key>();
  const raw = process.env.VAULT_KEY;
  if (!raw) return { current: null, all, problem: 'VAULT_KEY is not set' };
  const current = keyFrom(raw);
  if (!current) return { current: null, all, problem: `VAULT_KEY is too short — use a random string of at least ${MIN_SECRET_CHARS} characters (openssl rand -base64 32)` };
  all.set(current.id, current);
  // Decrypt-only keys, kept during a rotation until every row has been re-sealed.
  for (const prev of (process.env.VAULT_KEY_PREVIOUS ?? '').split(',').filter((p) => p.trim())) {
    const k = keyFrom(prev);
    if (!k) return { current: null, all, problem: `VAULT_KEY_PREVIOUS holds a key shorter than ${MIN_SECRET_CHARS} characters` };
    all.set(k.id, k);
  }
  return { current, all };
}

/** Whether the vault can run, and if not, what an operator has to fix. */
export function vaultStatus(): { ok: true; keyId: string } | { ok: false; detail: string } {
  const k = keys();
  return k.current ? { ok: true, keyId: k.current.id } : { ok: false, detail: k.problem ?? 'unusable VAULT_KEY' };
}

export class VaultUnavailable extends Error {}

/** Encrypt `plain` under the current key, bound to `aad`. */
export function seal(plain: string, aad: string): string {
  const { current } = keys();
  if (!current) throw new VaultUnavailable('vault is not configured');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', current.bytes, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, current.id, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Decrypt a sealed string. Throws on a wrong key, a wrong AAD or any tampering. */
export function open(sealed: string, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('not a sealed value');
  const [, kid, iv, tag, ct] = parts;
  const key = keys().all.get(kid);
  if (!key) throw new VaultUnavailable(`sealed under key ${kid}, which is not configured`);
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** The key id a sealed value names, or null when it is not one. */
export function sealedKeyId(sealed: string): string | null {
  const parts = sealed.split('.');
  return parts.length === 5 && parts[0] === VERSION ? parts[1] : null;
}

/** Nullable convenience for optional fields. */
export const sealOpt = (plain: string | null | undefined, aad: string): string | null =>
  plain == null || plain === '' ? null : seal(plain, aad);
export const openOpt = (sealed: string | null, aad: string): string | null => (sealed == null ? null : open(sealed, aad));

/** The AAD for one field of one entry. Changing this breaks every stored entry — don't. */
export function entryAad(tabId: string, entryId: string, field: 'username' | 'secret' | 'url' | 'notes'): string {
  return `secret_entry:${tabId}:${entryId}:${field}`;
}
