// Zero-knowledge crypto for one-time secret links (SECRET_LINKS_PLAN D1).
//
// The browser makes a fresh AES-256-GCM key per link, encrypts, and sends the server ONLY the
// ciphertext. The key goes into the URL fragment (`#…`), which browsers never send to a server — so
// a stolen database, a leaked backup or a fully compromised host yields nothing readable.
//
// Wire format: base64url(iv[12] ‖ AES-GCM output). The plaintext is JSON `{ v: 1, text }` so a later
// version can carry more than one field without guessing at the shape of old links.

const IV_BYTES = 12;
/** 32 bytes as unpadded base64url. Anything else in a fragment is a truncated or mangled link. */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** WebCrypto exists only in a secure context (https, or localhost). A LAN self-host over plain http
 *  has none, and should be told so rather than handed a broken button. */
export function linkCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

/** Whether a fragment is shaped like a key — checked BEFORE the reveal call, because the reveal
 *  burns the link and a truncated URL would otherwise destroy the secret for nothing. */
export function isLinkKey(fragment: string): boolean {
  return KEY_RE.test(fragment);
}

export async function encryptForLink(text: string): Promise<{ ciphertext: string; key: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify({ v: 1, text }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { ciphertext: toB64url(out), key: toB64url(raw) };
}

export async function decryptFromLink(ciphertext: string, keyB64: string): Promise<string> {
  const bytes = fromB64url(ciphertext);
  const key = await crypto.subtle.importKey('raw', fromB64url(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES));
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { v?: number; text?: unknown };
  if (parsed.v !== 1 || typeof parsed.text !== 'string') throw new Error('unrecognised secret format');
  return parsed.text;
}

/** The URL a recipient opens. Assembled HERE, never on the server — the server never sees `key`. */
export function linkUrl(id: string, key: string): string {
  return `${window.location.origin}/s/${encodeURIComponent(id)}#${key}`;
}

/** `/s/:id` → the id, or null when this is not a secret-link page. */
export function parseSecretLinkPath(path: string): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{10,64})\/?$/.exec(path);
  return m ? m[1] : null;
}
