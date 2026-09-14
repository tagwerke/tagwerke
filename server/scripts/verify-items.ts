// End-to-end check of commitment extraction (CONTRACT_TO_PROJECT_PLAN.md rung 3, §7).
//
// There is no model in this script, and that is the point. It stands up a tiny HTTP server that
// answers `/chat/completions` with canned replies and points AI_ENDPOINT at it, so the whole
// pipeline — chunking, the D6 quote gate, dedupe, the D7 human-wins rule, the ACL, the audit row —
// runs in CI and on a laptop with no GPU, deterministically, in about a second.
//
// It also means the headline behaviour can be tested at all: a real model cannot be asked, on
// demand, to hallucinate a specific quote. The stub can.
//
//   docker compose up -d db
//   npm run verify:items
//
// No object storage is needed: document rows are seeded directly, because nothing in this layer
// ever reads the bytes — it reads `text_content`, which is Agent A's job to fill on upload.

// Static, so it runs before the `??=` defaults below: a real .env wins, and these only fill gaps.
import 'dotenv/config';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

process.env.SESSION_SECRET ??= 'verify-items-secret-not-used-in-production';
// AI_ENDPOINT is set once the stub is listening and its port is known. The model name is
// arbitrary — the stub ignores it — but it has to be present or the feature reads as unconfigured.
process.env.AI_MODEL = 'verify-items-stub';
delete process.env.AI_API_KEY;

const { db, schema } = await import('../db/client.ts');
const { itemRoutes } = await import('../routes/items.ts');
const { createSession } = await import('../auth/session.ts');
const { chunkText, verifyQuote, indexDocument, CHUNK_CHARS, CHUNK_OVERLAP } = await import(
  '../lib/extractItems.ts'
);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

// ---- the document under test -------------------------------------------------
//
// Two of the quotes below deliberately straddle a line break. That is not decoration: `unpdf` and
// `mammoth` wrap text wherever the page did, so "the model quoted correctly but the document has a
// newline in the middle of it" is the single most common way a CORRECT item would be wrongly
// dropped. The stub sends those quotes on one line, as a model would.

const CONTRACT = `MASTER SERVICES AGREEMENT

1. Services. The Agency shall deliver three (3) initial brand identity
concepts within twenty (20) business days of the Effective Date.

2. Revisions. The Client is entitled to up to two (2) rounds of revision per
deliverable; additional rounds are billed at the prevailing hourly rate.

3. Exclusions. Excluded from this Agreement: print production, media buying,
and any third-party licensing fees.

4. Fees. The Client shall pay a fixed fee of $42,500, invoiced 50% on signature
and 50% on final delivery.

5. Term. This Agreement commences on 2026-10-01 and renews annually unless
either party gives sixty (60) days written notice.
`;

const DELIVERABLE_QUOTE =
  'The Agency shall deliver three (3) initial brand identity concepts within twenty (20) business days of the Effective Date.';
const LIMIT_QUOTE = 'up to two (2) rounds of revision per deliverable';
const DATE_QUOTE = 'This Agreement commences on 2026-10-01 and renews annually';
const EXCLUSION_QUOTE =
  'Excluded from this Agreement: print production, media buying, and any third-party licensing fees.';

// Fluent, plausible, formatted exactly like the real ones — and nowhere in the document. This is
// what a hallucinating model produces, and the only correct response to it is to drop it (D6).
const INVENTED_QUOTE =
  'The Agency shall provide 24/7 on-site support for the entire duration of the Term at no additional charge.';

function item(kind: string, text: string, quote: string, extra: Record<string, unknown> = {}) {
  return { kind, text, source_quote: quote, confidence: 0.8, ...extra };
}

const FIRST_RUN = [
  item('deliverable', 'Three initial brand identity concepts', DELIVERABLE_QUOTE),
  item('limit', 'Two rounds of revision per deliverable', LIMIT_QUOTE),
  item('date', 'Agreement commences', DATE_QUOTE, { due_date: '2026-10-01' }),
  item('deliverable', '24/7 on-site support', INVENTED_QUOTE),
];

// ---- a long document, built so one clause sits inside the overlap window (D10) ----
//
// The marker is placed 600 characters before the first chunk boundary, which puts it inside BOTH
// chunk 1 (0..CHUNK_CHARS) and chunk 2 (CHUNK_CHARS-CHUNK_OVERLAP..). Both calls will return it;
// exactly one row must land.

const MARKER = 'Agency shall produce one (1) quarterly performance report for each calendar quarter.';
const FILLER = 'The parties acknowledge the foregoing provisions of this Agreement. ';

function buildLongContract(): string {
  const target = CHUNK_CHARS - 600;
  let head = '';
  while (head.length + FILLER.length <= target) head += FILLER;
  return head + MARKER + ' ' + FILLER.repeat(40);
}
const LONG_CONTRACT = buildLongContract();

// ---- the stub model ----------------------------------------------------------

let aiCalls = 0;
// May return a promise, so a test can hold a reply open and create a genuine in-flight run — the
// only way to exercise the concurrency guard without racing the scheduler.
let replyFor: (excerpt: string) => unknown | Promise<unknown> = () => ({ items: [] });

const stub = http.createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    aiCalls++;
    const parsed = JSON.parse(body) as { messages: { content: string }[] };
    const excerpt = parsed.messages[parsed.messages.length - 1].content;
    void Promise.resolve(replyFor(excerpt)).then((payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The real envelope shape: content is a STRING of JSON, not an object. Getting this wrong in
      // the stub would hide a parsing bug in lib/ai.ts, which is half of what it is here to prove.
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
});

await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = (stub.address() as AddressInfo).port;
const STUB_ENDPOINT = `http://127.0.0.1:${stubPort}/v1`;
process.env.AI_ENDPOINT = STUB_ENDPOINT;

// ---- fixtures ----------------------------------------------------------------
const userId = `vu_${nanoid(8)}`;
const otherId = `vo_${nanoid(8)}`;
const tabId = `vt_${nanoid(8)}`;
const docId = `vd_${nanoid(8)}`;
const scanId = `vs_${nanoid(8)}`;
const longId = `vl_${nanoid(8)}`;
const stamp = Date.now();

async function seed(): Promise<{ cookieHeader: string; outsiderCookie: string }> {
  await db.insert(schema.users).values([
    { id: userId, email: `verify-items-${stamp}@example.test`, role: 'member' },
    { id: otherId, email: `verify-items-out-${stamp}@example.test`, role: 'member' },
  ]);
  await db.insert(schema.tabs).values({ id: tabId, name: 'verify-items board' });
  // Only the first user is a member; the second exists to prove the ACL actually refuses.
  await db.insert(schema.boardMembers).values({ tabId, userId, role: 'editor' });
  await db.insert(schema.documents).values([
    {
      id: docId, tabId, storageKey: `doc/${nanoid(24)}`, filename: 'msa.pdf',
      mime: 'application/pdf', size: CONTRACT.length, uploadedBy: userId,
      textContent: CONTRACT, textStatus: 'ok', textChars: CONTRACT.length, extractedAt: new Date(),
    },
    // D4: a scan. No text layer, so there is nothing honest to extract from it.
    {
      id: scanId, tabId, storageKey: `doc/${nanoid(24)}`, filename: 'scanned.pdf',
      mime: 'application/pdf', size: 1024, uploadedBy: userId,
      textContent: null, textStatus: 'no_text_layer',
    },
    {
      id: longId, tabId, storageKey: `doc/${nanoid(24)}`, filename: 'long-msa.pdf',
      mime: 'application/pdf', size: LONG_CONTRACT.length, uploadedBy: userId,
      textContent: LONG_CONTRACT, textStatus: 'ok', textChars: LONG_CONTRACT.length,
    },
  ]);
  return { cookieHeader: await createSession(userId), outsiderCookie: await createSession(otherId) };
}

async function cleanup(): Promise<void> {
  // document_items and documents cascade from the board; the users do not.
  await db.delete(schema.boardMembers).where(eq(schema.boardMembers.tabId, tabId));
  await db.delete(schema.tabs).where(eq(schema.tabs.id, tabId));
  for (const id of [userId, otherId]) await db.delete(schema.users).where(eq(schema.users.id, id));
}

// ---- the run -----------------------------------------------------------------
const app = Fastify({ logger: false });
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
await app.register(itemRoutes);
await app.ready();

function signed(sessionId: string): string {
  return `do_session=${app.signCookie(sessionId)}`;
}

interface ItemsBody {
  items: {
    id: string; kind: string; text: string; sourceQuote: string; sourceOffset?: number;
    dueDate?: string; confidence?: number; status: string; editedAt?: number;
  }[];
  run: { status: string; proposed?: number; dropped?: number; error?: string };
}

async function getItems(id: string, cookieHeader: string): Promise<ItemsBody> {
  const res = await app.inject({ method: 'GET', url: `/api/documents/${id}/items`, headers: { cookie: signed(cookieHeader) } });
  return res.json() as ItemsBody;
}

/** The run is fire-and-forget past the 202, so the script waits the way the UI polls. */
async function extractAndWait(id: string, cookieHeader: string): Promise<ItemsBody> {
  const start = await app.inject({ method: 'POST', url: `/api/documents/${id}/extract`, headers: { cookie: signed(cookieHeader) } });
  if (start.statusCode !== 202) throw new Error(`extract returned ${start.statusCode}: ${start.body}`);
  for (let i = 0; i < 200; i++) {
    const body = await getItems(id, cookieHeader);
    if (body.run.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('extraction run never finished');
}

const { cookieHeader, outsiderCookie } = await seed();

try {
  console.log('\nquote verification, in isolation (D6):');
  const idx = indexDocument(CONTRACT);
  const across = verifyQuote(DELIVERABLE_QUOTE, idx);
  check('a quote that spans a line break in the source still verifies', across !== null);
  check(
    'and its offset points at the real span in the ORIGINAL text',
    across !== null && CONTRACT.slice(across.offset, across.offset + across.quote.length) === across.quote,
    across?.offset,
  );
  check('the stored quote is the DOCUMENT text, not the model copy', across?.quote.includes('\n') === true, across?.quote);
  check('an invented quote does not verify', verifyQuote(INVENTED_QUOTE, idx) === null);
  check('a trivially short quote does not verify', verifyQuote('the', idx) === null);

  console.log('\nchunking (D10):');
  check('a short document is one chunk', chunkText(CONTRACT).length === 1);
  const longChunks = chunkText(LONG_CONTRACT);
  check('a long document is more than one chunk', longChunks.length > 1, longChunks.length);
  check(
    'consecutive chunks overlap by CHUNK_OVERLAP',
    longChunks.length > 1 && longChunks[1].start === CHUNK_CHARS - CHUNK_OVERLAP,
    longChunks.map((c) => c.start),
  );
  check(
    'the marker clause is whole inside BOTH chunks',
    longChunks.filter((c) => c.text.includes(MARKER)).length === 2,
    longChunks.filter((c) => c.text.includes(MARKER)).length,
  );

  console.log('\nunconfigured AI is a 503 that names the gap:');
  delete process.env.AI_ENDPOINT;
  const off = await app.inject({ method: 'POST', url: `/api/documents/${docId}/extract`, headers: { cookie: signed(cookieHeader) } });
  check('returns 503', off.statusCode === 503, off.statusCode);
  check('and says which env key is missing', (off.json().missing ?? []).includes('AI_ENDPOINT'), off.json());
  process.env.AI_ENDPOINT = STUB_ENDPOINT;

  console.log('\na document with no readable text is a 409 (D4):');
  const scan = await app.inject({ method: 'POST', url: `/api/documents/${scanId}/extract`, headers: { cookie: signed(cookieHeader) } });
  check('returns 409', scan.statusCode === 409, scan.statusCode);
  check('and carries the status, so the UI can explain it', scan.json().textStatus === 'no_text_layer', scan.json());

  console.log('\naccess control:');
  const anon = await app.inject({ method: 'GET', url: `/api/documents/${docId}/items` });
  check('an unauthenticated read is refused', anon.statusCode === 401, anon.statusCode);
  const outRead = await app.inject({ method: 'GET', url: `/api/documents/${docId}/items`, headers: { cookie: signed(outsiderCookie) } });
  check('a non-member cannot read items (404, not 403)', outRead.statusCode === 404, outRead.statusCode);
  const outExtract = await app.inject({ method: 'POST', url: `/api/documents/${docId}/extract`, headers: { cookie: signed(outsiderCookie) } });
  check('a non-member cannot start a run', outExtract.statusCode === 404, outExtract.statusCode);

  console.log('\nTHE HEADLINE — an unquotable item is dropped, not stored (D6):');
  replyFor = () => ({ items: FIRST_RUN });
  const first = await extractAndWait(docId, cookieHeader);
  check('the run completes', first.run.status === 'done', first.run);
  check('three real items are proposed', first.run.proposed === 3, first.run);
  check('the invented one is counted as dropped', first.run.dropped === 1, first.run);
  check('four items were offered, three stored', first.items.length === 3, first.items.length);
  check(
    'NOTHING in the database quotes text the document does not contain',
    first.items.every((i) => CONTRACT.replace(/\s+/g, ' ').includes(i.sourceQuote.replace(/\s+/g, ' ').trim())),
    first.items.map((i) => i.sourceQuote),
  );
  check(
    'the hallucinated commitment is absent entirely',
    !JSON.stringify(first.items).includes('24/7'),
    first.items.map((i) => i.text),
  );

  console.log('\nwhat a stored item carries:');
  const deliverable = first.items.find((i) => i.kind === 'deliverable');
  check('every item lands as proposed (D8)', first.items.every((i) => i.status === 'proposed'));
  check('the quote is the document’s own text', deliverable?.sourceQuote.includes('\n') === true, deliverable?.sourceQuote);
  check(
    'sourceOffset indexes documents.text_content exactly',
    first.items.every((i) => i.sourceOffset !== undefined && CONTRACT.slice(i.sourceOffset, i.sourceOffset + i.sourceQuote.length) === i.sourceQuote),
    first.items.map((i) => i.sourceOffset),
  );
  const dated = first.items.find((i) => i.kind === 'date');
  check('a stated due date survives', dated?.dueDate === '2026-10-01', dated?.dueDate);
  check('items come back in document order', first.items.every((i, n, a) => n === 0 || (a[n - 1].sourceOffset ?? 0) <= (i.sourceOffset ?? 0)));

  console.log('\na second run refuses to start while the first is going:');
  replyFor = () => new Promise((r) => setTimeout(() => r({ items: [] }), 400));
  const a = await app.inject({ method: 'POST', url: `/api/documents/${docId}/extract`, headers: { cookie: signed(cookieHeader) } });
  const b = await app.inject({ method: 'POST', url: `/api/documents/${docId}/extract`, headers: { cookie: signed(cookieHeader) } });
  check('the first is accepted with 202', a.statusCode === 202, a.statusCode);
  check('the second is refused with 409', b.statusCode === 409, b.statusCode);
  check('and hands back the running runId so the UI can poll it', b.json().runId === a.json().runId, b.json());
  for (let i = 0; i < 200 && (await getItems(docId, cookieHeader)).run.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  console.log('\na human edit survives re-extraction (D7):');
  const edited = deliverable!;
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/items/${edited.id}`,
    headers: { cookie: signed(cookieHeader) },
    payload: { text: 'Three logo concepts — confirmed with the client on the kickoff call' },
  });
  check('PATCH returns the updated item', patch.statusCode === 200, patch.body);
  check('and stamps editedAt', typeof patch.json().editedAt === 'number', patch.json().editedAt);
  const editedAt = patch.json().editedAt as number;

  // The same four items as before, PLUS one genuinely new one. A re-run may only ADD.
  replyFor = () => ({ items: [...FIRST_RUN, item('exclusion', 'Print production is out of scope', EXCLUSION_QUOTE)] });
  const second = await extractAndWait(docId, cookieHeader);
  check('the re-run adds only the new item', second.run.proposed === 1, second.run);
  check('and still drops the invented one', second.run.dropped === 1, second.run);
  check('the board now holds four items', second.items.length === 4, second.items.length);
  const after = second.items.find((i) => i.id === edited.id);
  check('the edited row was not duplicated', second.items.filter((i) => i.kind === 'deliverable').length === 1);
  check('the edited row kept the human’s text', after?.text === 'Three logo concepts — confirmed with the client on the kickoff call', after?.text);
  check('and kept its editedAt untouched', after?.editedAt === editedAt, { was: editedAt, now: after?.editedAt });

  console.log('\nchunk overlap does not double-count (D10):');
  const callsBefore = aiCalls;
  replyFor = (excerpt) => ({ items: excerpt.includes(MARKER) ? [item('deliverable', 'Quarterly performance report', MARKER)] : [] });
  const long = await extractAndWait(longId, cookieHeader);
  check('every chunk was sent to the model', aiCalls - callsBefore === longChunks.length, { calls: aiCalls - callsBefore, chunks: longChunks.length });
  check('the model returned the clause twice', longChunks.filter((c) => c.text.includes(MARKER)).length === 2);
  check('exactly one row was stored', long.items.length === 1, long.items.length);
  check('and it proposed one, not two', long.run.proposed === 1, long.run);

  console.log('\naccept-all touches only proposed rows:');
  const toReject = second.items.find((i) => i.kind === 'limit')!;
  await app.inject({
    method: 'PATCH', url: `/api/items/${toReject.id}`,
    headers: { cookie: signed(cookieHeader) }, payload: { status: 'rejected' },
  });
  const bulk = await app.inject({
    method: 'POST', url: `/api/documents/${docId}/items/accept-all`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('accepts the three still awaiting a decision', bulk.json().accepted === 3, bulk.json());
  const afterBulk = await getItems(docId, cookieHeader);
  check('the rejected row is still rejected', afterBulk.items.find((i) => i.id === toReject.id)?.status === 'rejected');
  check('everything else is accepted', afterBulk.items.filter((i) => i.status === 'accepted').length === 3, afterBulk.items.map((i) => i.status));
  const again = await app.inject({
    method: 'POST', url: `/api/documents/${docId}/items/accept-all`,
    headers: { cookie: signed(cookieHeader) },
  });
  check('a second accept-all is a no-op', again.json().accepted === 0, again.json());

  console.log('\nbad input:');
  const badPatch = await app.inject({
    method: 'PATCH', url: `/api/items/${toReject.id}`,
    headers: { cookie: signed(cookieHeader) }, payload: { status: 'proposed' },
  });
  check('a status outside accepted|rejected is refused', badPatch.statusCode === 400, badPatch.statusCode);
  const noQuoteEdit = await app.inject({
    method: 'PATCH', url: `/api/items/${toReject.id}`,
    headers: { cookie: signed(cookieHeader) }, payload: { sourceQuote: 'anything I like' },
  });
  check('sourceQuote is not patchable', noQuoteEdit.statusCode === 400, noQuoteEdit.statusCode);
  const stillQuoted = await getItems(docId, cookieHeader);
  check(
    'so every quote still matches the document after every write',
    stillQuoted.items.every((i) => CONTRACT.replace(/\s+/g, ' ').includes(i.sourceQuote.replace(/\s+/g, ' ').trim())),
  );

  console.log('\na model that is simply down:');
  process.env.AI_ENDPOINT = 'http://127.0.0.1:1/v1';
  const brokenDoc = await extractAndWait(longId, cookieHeader);
  check('the run reports an error rather than pretending to succeed', brokenDoc.run.status === 'error', brokenDoc.run);
  check('and stores nothing new', brokenDoc.items.length === 1, brokenDoc.items.length);
  process.env.AI_ENDPOINT = STUB_ENDPOINT;

  console.log('\naudit trail:');
  const rows = await db
    .select({ action: schema.auditLog.action, payload: schema.auditLog.payload })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.scopeId, tabId));
  const extracts = rows.filter((r) => r.action === 'document_extract');
  check('document_extract is recorded per run', extracts.length >= 3, extracts.length);
  const withDrop = extracts.find((r) => (r.payload as { dropped?: number } | null)?.dropped === 1);
  check('the drop count reaches the audit log', withDrop !== undefined, extracts.map((r) => r.payload));
  check(
    'and the run records the model it used',
    extracts.every((r) => (r.payload as { model?: string } | null)?.model === 'verify-items-stub'),
  );
} finally {
  await cleanup();
  await app.close();
  stub.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\nall item extraction checks passed.\n');
process.exit(0);
