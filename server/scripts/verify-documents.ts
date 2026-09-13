// End-to-end check of the document layer (DOCUMENTS_PLAN.md P1).
//
// P1 ships no UI, so this script IS the proof the layer works: it drives the real routes, through
// the real auth guard and the real board ACL, against a real bucket and a real database. It seeds
// its own throwaway user/board/session and removes them again.
//
//   docker compose up -d db minio
//   npm run verify:documents
//
// Talks to the dev MinIO from docker-compose.override.yml by default. Point S3_* at anything
// S3-compatible to check a different backend — that portability is the whole premise of D3.

// Static, so it runs before the `??=` defaults below: a real .env wins, and these only fill gaps.
import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { S3Client, CreateBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

// MUST precede the blobstore import: it reads config from env at first use.
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'tagwerke-dev';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_ACCESS_KEY_ID ??= 'devkey';
process.env.S3_SECRET_ACCESS_KEY ??= 'devsecret123';
process.env.SESSION_SECRET ??= 'verify-documents-secret-not-used-in-production';
// Deliberately tiny: routes/documents.ts reads this at module load, so setting it here is what
// makes the over-cap path testable without pushing 100 MiB through the meter.
process.env.MAX_UPLOAD_BYTES = '4096';

const { db, schema } = await import('../db/client.ts');
const { documentRoutes } = await import('../routes/documents.ts');
const { createSession } = await import('../auth/session.ts');
const { configFromEnv, s3Blobstore } = await import('../lib/blobstore.ts');
const { tabRoutes } = await import('../routes/tabs.ts');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

// ---- fixtures ----------------------------------------------------------------
const userId = `vu_${nanoid(8)}`;
const otherId = `vo_${nanoid(8)}`;
const tabId = `vt_${nanoid(8)}`;
const stamp = Date.now();

async function seed(): Promise<{ cookieHeader: string; outsiderCookie: string }> {
  await db.insert(schema.users).values([
    { id: userId, email: `verify-${stamp}@example.test`, role: 'member' },
    { id: otherId, email: `verify-out-${stamp}@example.test`, role: 'member' },
  ]);
  await db.insert(schema.tabs).values({ id: tabId, name: 'verify-documents board' });
  // Only the first user is a member; the second exists to prove the ACL actually refuses.
  // Admin, not editor: board deletion requires it, and admin outranks editor so every
  // editor-gated route below is still exercised at its real threshold.
  await db.insert(schema.boardMembers).values({ tabId, userId, role: 'admin' });
  return {
    cookieHeader: await createSession(userId),
    outsiderCookie: await createSession(otherId),
  };
}

async function cleanup(): Promise<void> {
  const docs = await db.select().from(schema.documents).where(eq(schema.documents.tabId, tabId));
  const cfg = configFromEnv();
  if (cfg) {
    const store = s3Blobstore(cfg);
    for (const d of docs) await store.delete(d.storageKey).catch(() => {});
  }
  await db.delete(schema.documents).where(eq(schema.documents.tabId, tabId));
  await db.delete(schema.boardMembers).where(eq(schema.boardMembers.tabId, tabId));
  await db.delete(schema.tabs).where(eq(schema.tabs.id, tabId));
  for (const id of [userId, otherId]) await db.delete(schema.users).where(eq(schema.users.id, id));
}

// ---- bucket ------------------------------------------------------------------
async function ensureBucket(): Promise<void> {
  const cfg = configFromEnv()!;
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
    console.log(`created bucket ${cfg.bucket}`);
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    // The app never creates buckets — an operator does. This is test setup only.
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(name)) throw err;
  }
}

async function objectCount(): Promise<number> {
  const cfg = configFromEnv()!;
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
  });
  const out = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket }));
  return out.KeyCount ?? 0;
}

// ---- the run -----------------------------------------------------------------
const app = Fastify({ logger: false });
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
await app.register(documentRoutes);
// Registered so board deletion can be exercised through the REAL route: it is the most common
// way document rows disappear, and the objects have to go with them.
await app.register(tabRoutes);
await app.ready();

function signed(sessionId: string): string {
  return `do_session=${app.signCookie(sessionId)}`;
}

function multipartBody(filename: string, content: Buffer, declaredType: string) {
  const boundary = `----verify${nanoid(12)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${declaredType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

await ensureBucket();
const { cookieHeader, outsiderCookie } = await seed();

try {
  console.log('\nupload:');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x41)]);
  const mp = multipartBody('quarterly report.pdf', pdf, 'text/html');
  const up = await app.inject({
    method: 'POST',
    url: `/api/boards/${tabId}/documents`,
    headers: { ...mp.headers, cookie: signed(cookieHeader) },
    payload: mp.payload,
  });
  check('returns 200', up.statusCode === 200, up.statusCode === 200 ? undefined : up.body);
  const doc = up.statusCode === 200 ? up.json() : {};
  check('records the true size', doc.size === pdf.length, { got: doc.size, want: pdf.length });
  check('sniffs application/pdf, ignoring the declared text/html', doc.mime === 'application/pdf', doc.mime);
  check('records a sha256', typeof doc.sha256 === 'string' && doc.sha256.length === 64);

  console.log('\naccess control:');
  const denied = await app.inject({
    method: 'POST',
    url: `/api/boards/${tabId}/documents`,
    headers: { ...mp.headers, cookie: signed(outsiderCookie) },
    payload: multipartBody('sneaky.pdf', pdf, 'application/pdf').payload,
  });
  check('a non-member cannot upload (404, not 403)', denied.statusCode === 404, denied.statusCode);
  const anon = await app.inject({ method: 'GET', url: `/api/documents/${doc.id}/content` });
  check('an unauthenticated download is refused', anon.statusCode === 401, anon.statusCode);
  const outsiderGet = await app.inject({
    method: 'GET',
    url: `/api/documents/${doc.id}/content`,
    headers: { cookie: signed(outsiderCookie) },
  });
  check('a non-member cannot download', outsiderGet.statusCode === 404, outsiderGet.statusCode);

  console.log('\nlist:');
  const list = await app.inject({
    method: 'GET',
    url: `/api/boards/${tabId}/documents`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('lists the upload', list.json().documents?.length === 1, list.json());
  check('list never carries bytes', !JSON.stringify(list.json()).includes('storageKey'));

  console.log('\ndownload:');
  const dl = await app.inject({
    method: 'GET',
    url: `/api/documents/${doc.id}/content`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('returns 200', dl.statusCode === 200, dl.statusCode);
  check('bytes round-trip exactly', Buffer.compare(dl.rawPayload, pdf) === 0);
  check('content-type is the sniffed type', dl.headers['content-type'] === 'application/pdf', dl.headers['content-type']);
  check(
    'disposition is attachment, never inline',
    String(dl.headers['content-disposition']).startsWith('attachment;'),
    dl.headers['content-disposition'],
  );

  console.log('\nthe dangerous case — an .html upload:');
  const html = Buffer.from('<script>alert(document.cookie)</script>');
  const hm = multipartBody('payload.html', html, 'text/html');
  const hup = await app.inject({
    method: 'POST',
    url: `/api/boards/${tabId}/documents`,
    headers: { ...hm.headers, cookie: signed(cookieHeader) },
    payload: hm.payload,
  });
  const hdoc = hup.json();
  const hdl = await app.inject({
    method: 'GET',
    url: `/api/documents/${hdoc.id}/content`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('is NEVER served as text/html', hdl.headers['content-type'] !== 'text/html', hdl.headers['content-type']);
  check(
    'downloads as an attachment',
    String(hdl.headers['content-disposition']).startsWith('attachment;'),
    hdl.headers['content-disposition'],
  );

  console.log('\nsize cap:');
  const before = await objectCount();
  const huge = Buffer.alloc(8192, 0x42);
  const bm = multipartBody('huge.bin', huge, 'application/octet-stream');
  const over = await app.inject({
    method: 'POST',
    url: `/api/boards/${tabId}/documents`,
    headers: { ...bm.headers, cookie: signed(cookieHeader) },
    payload: bm.payload,
  });
  check('a file over the cap is refused with 413', over.statusCode === 413, over.statusCode);
  // The point of aborting mid-stream rather than truncating: nothing partial is left behind.
  const after = await objectCount();
  check('and leaves no orphaned object in the bucket', after === before, { before, after });

  console.log('\ndelete and restore:');
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/documents/${doc.id}`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('delete returns 200', del.statusCode === 200, del.statusCode);
  const afterDel = await app.inject({
    method: 'GET',
    url: `/api/documents/${doc.id}/content`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('a deleted document 404s', afterDel.statusCode === 404, afterDel.statusCode);
  const listAfter = await app.inject({
    method: 'GET',
    url: `/api/boards/${tabId}/documents`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('and leaves the list', listAfter.json().documents?.length === 1, listAfter.json());

  const res = await app.inject({
    method: 'POST',
    url: `/api/documents/${doc.id}/restore`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('restore returns 200', res.statusCode === 200, res.statusCode);
  const afterRes = await app.inject({
    method: 'GET',
    url: `/api/documents/${doc.id}/content`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('the bytes survived the round trip through Trash', Buffer.compare(afterRes.rawPayload, pdf) === 0);

  console.log('\ndeleting the board takes its objects with it:');
  const beforeBoardDelete = await objectCount();
  const boardDel = await app.inject({
    method: 'DELETE',
    url: `/api/tabs/${tabId}`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('board delete returns 200', boardDel.statusCode === 200, boardDel.body);
  const remaining = await db.select().from(schema.documents).where(eq(schema.documents.tabId, tabId));
  check('document rows cascade away', remaining.length === 0, remaining.length);
  const afterBoardDelete = await objectCount();
  check('and the objects are gone from the bucket too', afterBoardDelete < beforeBoardDelete, {
    before: beforeBoardDelete,
    after: afterBoardDelete,
  });

  console.log('\naudit trail:');
  const rows = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.scopeId, tabId));
  const actions = rows.map((r) => r.action);
  for (const a of ['document_upload', 'document_delete', 'document_restore']) {
    check(`${a} recorded`, actions.includes(a), actions);
  }
} finally {
  await cleanup();
  await app.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\nall document checks passed.\n');
process.exit(0);
