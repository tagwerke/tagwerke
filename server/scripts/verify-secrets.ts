// End-to-end check of board secrets + one-time secret links (SECRET_LINKS_PLAN.md): the vault's
// AAD binding and key rotation, the admin-only / network-policy / step-up gates, that nothing
// secret reaches audit_log, and the link burn — exactly once under a race, with one identical
// answer for missing, burned, expired and revoked. Runs against the dev DB in throwaway boards it
// cleans up.
//
//   npm run verify:secrets

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

process.env.SESSION_SECRET ??= 'verify-secrets-secret-not-used-in-production';
const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
process.env.VAULT_KEY = KEY_A;
delete process.env.VAULT_KEY_PREVIOUS;

const { db, pool, schema } = await import('../db/client.ts');
const { secretRoutes, publicSecretRoutes } = await import('../routes/secrets.ts');
const { createSession, SESSION_COOKIE } = await import('../auth/session.ts');
const { registerAuditHook } = await import('../lib/audit.ts');
const vault = await import('../lib/vault.ts');
const { ipInCidrs, parseCidr, withinPin } = await import('../lib/ipnet.ts');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const [board, otherBoard, admin, editor, outsider] = Array.from({ length: 5 }, () => nanoid());
const SECRET = `hunter2-${nanoid()}`;
const NOTES = `recovery phrase ${nanoid()}`;

const app = Fastify({ trustProxy: true });
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
registerAuditHook(app);
await app.register(rateLimit, { global: false });
await app.register(secretRoutes);
await app.register(publicSecretRoutes);

async function cookieFor(userId: string): Promise<string> {
  const sid = await createSession(userId);
  return `${SESSION_COOKIE}=${app.signCookie(sid)}`;
}
const sudo = (userId: string, on: boolean) =>
  db.update(schema.sessions).set({ sudoAt: on ? new Date() : null }).where(eq(schema.sessions.userId, userId));

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, cookieHeader?: string, payload?: object, ip = '203.0.113.7') =>
  app.inject({
    method, url, payload,
    headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), 'x-forwarded-for': ip },
  });

async function cleanup(): Promise<void> {
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.actorId, [admin, editor, outsider]));
  await db.delete(schema.secretLinks).where(inArray(schema.secretLinks.createdBy, [admin, editor, outsider]));
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [board, otherBoard])); // cascades entries, policy, members
  await db.delete(schema.users).where(inArray(schema.users.id, [admin, editor, outsider]));
}

try {
  // ---- pure helpers ---------------------------------------------------------
  console.log('vault');
  const sealed = vault.seal('s3cret', 'ctx-a');
  check('seal → open round-trips', vault.open(sealed, 'ctx-a') === 's3cret');
  check('a different AAD refuses to open', throws(() => vault.open(sealed, 'ctx-b')));
  check('a tampered ciphertext refuses to open', throws(() => vault.open(sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA'), 'ctx-a')));
  check('ciphertext does not contain the plaintext', !sealed.includes('s3cret'));
  process.env.VAULT_KEY = KEY_B;
  check('a rotated key without PREVIOUS cannot open old rows', throws(() => vault.open(sealed, 'ctx-a')));
  process.env.VAULT_KEY_PREVIOUS = KEY_A;
  check('VAULT_KEY_PREVIOUS still opens old rows', vault.open(sealed, 'ctx-a') === 's3cret');
  check('new seals use the new key', vault.sealedKeyId(vault.seal('x', 'y')) !== vault.sealedKeyId(sealed));
  process.env.VAULT_KEY = KEY_A;
  delete process.env.VAULT_KEY_PREVIOUS;
  process.env.VAULT_KEY = 'too-short';
  check('a short VAULT_KEY disables the vault', !vault.vaultStatus().ok);
  // A SESSION_SECRET-style string: any long random text, stretched with HKDF.
  const PASSPHRASE = 'x7Kq-just_a long random string! no particular format 9f3a';
  process.env.VAULT_KEY = PASSPHRASE;
  const phraseStatus = vault.vaultStatus();
  check('a long arbitrary string is accepted as VAULT_KEY', phraseStatus.ok);
  const phraseSealed = vault.seal('s3cret', 'ctx-a');
  check('…and round-trips', vault.open(phraseSealed, 'ctx-a') === 's3cret');
  process.env.VAULT_KEY = `  ${PASSPHRASE}
`;
  check('…stably (surrounding whitespace ignored)', vault.open(phraseSealed, 'ctx-a') === 's3cret');
  process.env.VAULT_KEY = PASSPHRASE + 'y';
  check('…and a different string cannot open it', throws(() => vault.open(phraseSealed, 'ctx-a')));
  process.env.VAULT_KEY = Buffer.from(KEY_A, 'base64').toString('hex');
  check('the same 32 bytes as hex is the same key as base64', vault.open(sealed, 'ctx-a') === 's3cret');
  process.env.VAULT_KEY = KEY_A;

  console.log('ipnet');
  check('IPv4 CIDR match', ipInCidrs('10.1.2.3', ['10.0.0.0/8']));
  check('IPv4 CIDR miss', !ipInCidrs('11.1.2.3', ['10.0.0.0/8']));
  check('IPv4-mapped IPv6 matches an IPv4 rule', ipInCidrs('::ffff:10.1.2.3', ['10.0.0.0/8']));
  check('bare address = single host', ipInCidrs('192.0.2.5', ['192.0.2.5']) && !ipInCidrs('192.0.2.6', ['192.0.2.5']));
  check('IPv6 CIDR match', ipInCidrs('2001:db8::1', ['2001:db8::/32']));
  check('garbage rule rejected', parseCidr('10.0.0.0/33') === null && parseCidr('nope') === null);
  check('pin /24 tolerates a rotated low octet', withinPin('198.51.100.9', '198.51.100.200', 24));
  check('pin /32 does not', !withinPin('198.51.100.9', '198.51.100.200', 32));

  // ---- seed -----------------------------------------------------------------
  await db.insert(schema.users).values([
    { id: admin, email: `admin-${admin}@verify.test`, role: 'member' },
    { id: editor, email: `editor-${editor}@verify.test`, role: 'member' },
    { id: outsider, email: `out-${outsider}@verify.test`, role: 'member' },
  ]);
  await db.insert(schema.tabs).values([
    { id: board, name: 'verify-secrets', type: 'normal', createdBy: admin },
    { id: otherBoard, name: 'verify-secrets other', type: 'normal', createdBy: admin },
  ]);
  await db.insert(schema.boardMembers).values([
    { tabId: board, userId: admin, role: 'admin' },
    { tabId: board, userId: editor, role: 'editor' },
    { tabId: otherBoard, userId: admin, role: 'admin' },
  ]);
  const cAdmin = await cookieFor(admin);
  const cEditor = await cookieFor(editor);
  const cOut = await cookieFor(outsider);

  // ---- gates ----------------------------------------------------------------
  console.log('board secret gates');
  check('anonymous → 401', (await call('GET', `/api/boards/${board}/secrets`)).statusCode === 401);
  check('non-member → 404 (not probeable)', (await call('GET', `/api/boards/${board}/secrets`, cOut)).statusCode === 404);
  check('editor → 403', (await call('GET', `/api/boards/${board}/secrets`, cEditor)).statusCode === 403);
  const list0 = await call('GET', `/api/boards/${board}/secrets`, cAdmin);
  check('admin may list', list0.statusCode === 200, list0.body);
  check('list is no-store', list0.headers['cache-control'] === 'no-store');

  const body = { name: 'Stripe prod', username: 'ops@acme.test', secret: SECRET, url: 'https://dashboard.stripe.com', notes: NOTES };
  await sudo(admin, false);
  const noSudo = await call('POST', `/api/boards/${board}/secrets`, cAdmin, body);
  check('create without step-up → 401 sudo required', noSudo.statusCode === 401 && noSudo.json().error === 'sudo required', noSudo.body);
  await sudo(admin, true);
  const created = await call('POST', `/api/boards/${board}/secrets`, cAdmin, body);
  check('create with step-up', created.statusCode === 200, created.body);
  const entry = created.json() as { id: string; username?: string; hasNotes: boolean };
  check('DTO carries username, never the secret', entry.username === body.username && !created.body.includes(SECRET) && !created.body.includes(NOTES));

  const [raw] = await db.select().from(schema.secretEntries).where(eq(schema.secretEntries.id, entry.id));
  check('stored row holds no plaintext', !JSON.stringify(raw).includes(SECRET) && !JSON.stringify(raw).includes(NOTES) && !JSON.stringify(raw).includes(body.username));

  const list1 = await call('GET', `/api/boards/${board}/secrets`, cAdmin);
  check('list never carries the secret', list1.statusCode === 200 && !list1.body.includes(SECRET) && !list1.body.includes(NOTES));

  check('editor cannot reveal', (await call('POST', `/api/secrets/${entry.id}/reveal`, cEditor)).statusCode === 403);
  check('non-member cannot reveal (404)', (await call('POST', `/api/secrets/${entry.id}/reveal`, cOut)).statusCode === 404);
  await sudo(admin, false);
  check('reveal without step-up → 401', (await call('POST', `/api/secrets/${entry.id}/reveal`, cAdmin)).statusCode === 401);
  await sudo(admin, true);
  const revealed = await call('POST', `/api/secrets/${entry.id}/reveal`, cAdmin);
  check('admin + step-up reveals', revealed.statusCode === 200 && revealed.json().secret === SECRET && revealed.json().notes === NOTES, revealed.body);

  // A ciphertext moved onto another entry must not open there (AAD).
  const moved = nanoid();
  await db.insert(schema.secretEntries).values({ id: moved, tabId: otherBoard, name: 'moved', secretEnc: raw.secretEnc });
  const movedReveal = await call('POST', `/api/secrets/${moved}/reveal`, cAdmin);
  check('a ciphertext copied to another board fails to decrypt', movedReveal.statusCode === 500 && !movedReveal.body.includes(SECRET));

  const patched = await call('PATCH', `/api/secrets/${entry.id}`, cAdmin, { secret: 'rotated-value', notes: null });
  check('edit', patched.statusCode === 200 && patched.json().hasNotes === false, patched.body);
  const after = await call('POST', `/api/secrets/${entry.id}/reveal`, cAdmin);
  check('edit took effect', after.json().secret === 'rotated-value' && after.json().notes === undefined);

  // ---- network policy -------------------------------------------------------
  console.log('network policy');
  const lockout = await call('PUT', `/api/boards/${board}/secret-policy`, cAdmin, { allowedCidrs: ['10.0.0.0/8'] });
  check('a policy excluding your own address is refused', lockout.statusCode === 400, lockout.body);
  const bad = await call('PUT', `/api/boards/${board}/secret-policy`, cAdmin, { allowedCidrs: ['10.0.0.0/99'] });
  check('a malformed rule is refused', bad.statusCode === 400);
  const setPol = await call('PUT', `/api/boards/${board}/secret-policy`, cAdmin, { allowedCidrs: ['203.0.113.0/24', '2001:db8::/32'] });
  check('policy saved', setPol.statusCode === 200, setPol.body);
  check('inside policy → allowed', (await call('GET', `/api/boards/${board}/secrets`, cAdmin, undefined, '203.0.113.99')).statusCode === 200);
  const outside = await call('POST', `/api/secrets/${entry.id}/reveal`, cAdmin, undefined, '198.51.100.1');
  check('outside policy → 403 ip_not_allowed, even for an admin with step-up', outside.statusCode === 403 && outside.json().code === 'ip_not_allowed', outside.body);
  check('…and it says nothing secret', !outside.body.includes('rotated-value'));
  await call('PUT', `/api/boards/${board}/secret-policy`, cAdmin, { allowedCidrs: [] });
  check('cleared policy → open again', (await call('GET', `/api/boards/${board}/secrets`, cAdmin, undefined, '198.51.100.1')).statusCode === 200);

  // ---- vault off ------------------------------------------------------------
  delete process.env.VAULT_KEY;
  const off = await call('GET', `/api/boards/${board}/secrets`, cAdmin);
  check('no VAULT_KEY → 503 vault_off, not a half-working vault', off.statusCode === 503 && off.json().code === 'vault_off');
  check('…saying why', off.json().detail === 'VAULT_KEY is not set', off.body);
  process.env.VAULT_KEY = 'too-short-key';
  const badKey = await call('GET', `/api/boards/${board}/secrets`, cAdmin);
  check('a too-short key says so, without echoing it', /too short/.test(badKey.json().detail) && !badKey.body.includes('too-short-key'), badKey.body);
  process.env.VAULT_KEY = KEY_A;

  // ---- secret links ---------------------------------------------------------
  console.log('secret links');
  const ct = randomBytes(64).toString('base64url');
  const mk = (extra: object = {}) => call('POST', '/api/secret-links', cAdmin, { ciphertext: ct, ttlSeconds: 3600, label: 'for accounting', tabId: board, ...extra });
  check('editor cannot file a link under the board', (await call('POST', '/api/secret-links', cEditor, { ciphertext: ct, ttlSeconds: 3600, tabId: board })).statusCode === 403);
  check('a TTL beyond 7 days is refused', (await mk({ ttlSeconds: 8 * 86400 })).statusCode === 400);
  const link = (await mk()).json() as { id: string };
  check('link created', typeof link.id === 'string' && link.id.length >= 20);

  const reveal = (id: string, ip = '192.0.2.10') => call('POST', `/api/public/secret-links/${id}/reveal`, undefined, undefined, ip);
  // Five racers, one payload (D3).
  const race = await Promise.all(Array.from({ length: 5 }, () => reveal(link.id)));
  const winners = race.filter((r) => r.statusCode === 200);
  check('exactly one concurrent reveal gets the payload', winners.length === 1, race.map((r) => r.statusCode));
  check('the payload is the ciphertext, intact', winners[0]?.json().ciphertext === ct);
  check('public reveal is noindex + no-store', winners[0]?.headers['x-robots-tag'] === 'noindex, nofollow' && winners[0]?.headers['cache-control'] === 'no-store');
  const [burned] = await db.select().from(schema.secretLinks).where(eq(schema.secretLinks.id, link.id));
  check('burn blanks the stored ciphertext', burned.ciphertext === '' && burned.viewedAt != null && burned.viewedIp === '192.0.2.10');

  const expiredId = (await mk()).json().id as string;
  await db.update(schema.secretLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.secretLinks.id, expiredId));
  const revokedId = (await mk()).json().id as string;
  check('sender may revoke', (await call('DELETE', `/api/secret-links/${revokedId}`, cAdmin)).statusCode === 200);
  check('someone else may not revoke', (await call('DELETE', `/api/secret-links/${expiredId}`, cOut)).statusCode === 404);

  const answers = await Promise.all([reveal(link.id), reveal(expiredId), reveal(revokedId), reveal(nanoid())]);
  const shapes = answers.map((r) => `${r.statusCode} ${r.body}`);
  check('burned / expired / revoked / never-existed are indistinguishable', new Set(shapes).size === 1, shapes);

  // Re-open after burn from a far-away network → the sender is told; same network → not.
  await reveal(link.id, '192.0.2.10');
  const [same] = await db.select().from(schema.secretLinks).where(eq(schema.secretLinks.id, link.id));
  check('a re-open from the reader’s own address is not flagged', same.foreignAttemptAt == null);
  await reveal(link.id, '198.51.100.77');
  const [flagged] = await db.select().from(schema.secretLinks).where(eq(schema.secretLinks.id, link.id));
  check('a re-open from another network is flagged for the sender', flagged.foreignAttemptAt != null);

  const mine = await call('GET', `/api/secret-links?tabId=${board}`, cAdmin);
  const listed = mine.json().links as Array<{ id: string; status: string; label?: string }>;
  check('sender’s list shows opened / expired', listed.find((l) => l.id === link.id)?.status === 'opened' && listed.find((l) => l.id === expiredId)?.status === 'expired');
  check('sender’s list never carries ciphertext', !mine.body.includes(ct));
  check('another user sees none of them', ((await call('GET', '/api/secret-links', cOut)).json().links as unknown[]).length === 0);

  // ---- nothing secret in the audit log --------------------------------------
  console.log('audit');
  const rows = await db.select().from(schema.auditLog).where(inArray(schema.auditLog.actorId, [admin, editor, outsider]));
  const linkRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetType, 'secret_link'));
  const dump = JSON.stringify([...rows, ...linkRows]);
  check('audit rows were written', rows.some((r) => r.action === 'secret_reveal') && rows.some((r) => r.action === 'secret_access_denied_ip'));
  check('no secret, notes, username, ciphertext or label in audit_log', ![SECRET, NOTES, body.username, 'rotated-value', ct, 'for accounting'].some((s) => dump.includes(s)));
  check('no generic body-logging row for secret routes', !rows.some((r) => r.action.startsWith('POST /api') || r.action.startsWith('PATCH /api')));
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  await app.close();
  await pool.end();
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall secret checks passed');
