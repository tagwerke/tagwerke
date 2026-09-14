// Document upload (DOCUMENTS_PLAN.md P1). Bytes go to S3-compatible object storage; this file owns
// the row, the authorization and the response headers.
//
// Two things here are load-bearing and easy to undo by accident:
//
//   1. The board id is a ROUTE PARAM, never a multipart field (D7). requireBoardRole is a preHandler
//      and runs before the body exists — for multipart the body is a stream this handler consumes
//      itself, so a guard reading a form field would be authorizing against something it cannot see.
//   2. The download's Content-Type comes from SNIFFED bytes, and the disposition is always
//      `attachment` (§5). Serving an uploaded .svg or .html inline would execute it on this origin
//      with the viewer's session cookie. That is the whole reason P0 shipped first.

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId, restrictsDeleteToAdmin, hasBoardRole } from '../auth/boards.ts';
import { recordAudit } from '../lib/audit.ts';
import { publish, boardChannel } from '../lib/bus.ts';
import { blobstore } from '../lib/blobstore.ts';
import { sniffMime, safeFilename, SNIFF_BYTES, FALLBACK_MIME } from '../lib/mime.ts';
import { canExtract, extractText, TEXT_EXTRACT_MAX_BYTES } from '../lib/textExtract.ts';

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);
const BOARD_QUOTA_BYTES = Number(process.env.BOARD_QUOTA_BYTES ?? 5 * 1024 * 1024 * 1024);

// Mirrors IMPORT_RL: an upload is expensive in bandwidth and storage, and unlike task edits there is
// no legitimate reason to issue them in a tight loop.
const UPLOAD_RL = { max: 30, timeWindow: '1 minute' } as const;

/** Types we are willing to name in a download response. Anything else goes out as octet-stream. */
const SERVE_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'video/mp4',
  'audio/mpeg',
  'text/plain; charset=utf-8',
]);

interface DocumentRow {
  id: string;
  tabId: string;
  taskId: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  textStatus: string;
  textChars: number | null;
  uploadedBy: string | null;
  createdAt: Date;
}

interface ItemCounts {
  proposed: number;
  accepted: number;
}

/** A document nobody has extracted commitments from yet. Not a magic value — the honest answer. */
const NO_ITEMS: ItemCounts = { proposed: 0, accepted: 0 };

/** Matches `DocumentDTO` in src/types.ts. Additive only: the strip, the panel and the realtime
 *  frame all read this one shape, so a field that appears in one place must appear in all. */
function documentDTO(d: DocumentRow, itemCounts: ItemCounts = NO_ITEMS): Record<string, unknown> {
  return {
    id: d.id,
    tabId: d.tabId,
    taskId: d.taskId ?? undefined,
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    sha256: d.sha256 ?? undefined,
    uploadedBy: d.uploadedBy ?? undefined,
    createdAt: d.createdAt instanceof Date ? d.createdAt.getTime() : undefined,
    textStatus: d.textStatus,
    textChars: d.textChars ?? undefined,
    itemCounts,
  };
}

/**
 * Proposed/accepted item counts for a set of documents, in ONE grouped query.
 *
 * The board Files view lists every document at once, so the obvious per-row count is an N+1 that
 * grows with the board. `text_content` is deliberately never selected here — a list of twenty
 * contracts would be twenty megabytes of prose nothing on screen displays.
 */
async function itemCountsFor(documentIds: string[]): Promise<Map<string, ItemCounts>> {
  const counts = new Map<string, ItemCounts>();
  if (documentIds.length === 0) return counts;

  const rows = await db
    .select({
      documentId: schema.documentItems.documentId,
      status: schema.documentItems.status,
      n: sql<string>`count(*)`,
    })
    .from(schema.documentItems)
    .where(inArray(schema.documentItems.documentId, documentIds))
    .groupBy(schema.documentItems.documentId, schema.documentItems.status);

  for (const row of rows) {
    const entry = counts.get(row.documentId) ?? { proposed: 0, accepted: 0 };
    // `rejected` is counted by neither: the UI shows what is outstanding and what is confirmed,
    // and a rejection is the absence of both.
    if (row.status === 'proposed') entry.proposed = Number(row.n);
    else if (row.status === 'accepted') entry.accepted = Number(row.n);
    counts.set(row.documentId, entry);
  }
  return counts;
}

async function documentDTOWithCounts(row: DocumentRow): Promise<Record<string, unknown>> {
  const counts = await itemCountsFor([row.id]);
  return documentDTO(row, counts.get(row.id) ?? NO_ITEMS);
}

/** Resolver for routes keyed by a `:id` that is a DOCUMENT id: looks up its owning board. */
const documentBoard = async (req: FastifyRequest): Promise<string | undefined> => {
  const { id } = req.params as { id: string };
  const rows = await db
    .select({ tabId: schema.documents.tabId })
    .from(schema.documents)
    .where(eq(schema.documents.id, id))
    .limit(1);
  return rows[0]?.tabId;
};

/** Bytes currently counted against a board's quota. Soft-deleted rows still occupy the bucket. */
async function boardUsage(tabId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.documents.size}), 0)` })
    .from(schema.documents)
    .where(eq(schema.documents.tabId, tabId));
  return Number(row?.total ?? 0);
}

/**
 * Passes bytes through untouched while measuring them.
 *
 * Three jobs in one pass so the file is never held whole in memory: hash it, keep the first
 * SNIFF_BYTES for type detection, and abort the moment it exceeds the cap. The abort is an error
 * rather than a truncation on purpose — lib-storage aborts the multipart upload when its source
 * errors, so a rejected file leaves no partial object behind.
 */
function meter(): { stream: Transform; size(): number; digest(): string; head(): Buffer } {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let headLen = 0;
  let total = 0;

  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        cb(Object.assign(new Error('file too large'), { code: 'FILE_TOO_LARGE' }));
        return;
      }
      hash.update(chunk);
      if (headLen < SNIFF_BYTES) {
        const take = chunk.subarray(0, SNIFF_BYTES - headLen);
        chunks.push(take);
        headLen += take.length;
      }
      cb(null, chunk);
    },
  });

  return {
    stream,
    size: () => total,
    digest: () => hash.digest('hex'),
    head: () => Buffer.concat(chunks),
  };
}

/**
 * Pull text out of a freshly uploaded document and write it back to the row.
 *
 * D2: this runs AFTER the reply has gone out and never blocks it. Extraction is cheap and
 * deterministic — no model, no network beyond the bucket — but a 200-page PDF is still seconds of
 * CPU, and the uploader asked for an upload, not a parse. The row carries `text_status = 'pending'`
 * from its column default until this finishes, which is exactly what the UI renders.
 *
 * The bytes are RE-FETCHED from the bucket rather than teed out of the upload stream. Teeing looks
 * cheaper and is not: the common case is a file we will not read at all (an image, a video, a
 * 90 MiB zip), and teeing pays full memory for it before finding that out. Re-fetching keeps the
 * upload path's memory flat and makes this function re-runnable later, which a "re-extract" button
 * and any future OCR pass both need.
 */
function startExtraction(row: DocumentRow & { storageKey: string }, log: FastifyBaseLogger): void {
  // The whole point is to not be awaited, so nothing above catches a rejection. An unhandled one
  // takes the process down under Node's default policy — the crash would be in a request that
  // already returned 200, which is about as hard to diagnose as this gets.
  void extractInBackground(row, log).catch((err) => {
    log.error({ err, documentId: row.id }, 'text extraction failed outside its own handler');
  });
}

async function extractInBackground(
  row: DocumentRow & { storageKey: string },
  log: FastifyBaseLogger,
): Promise<void> {
  // Both of these are re-checked inside extractText(). Deciding them here is purely about not
  // streaming a 4 GiB video out of object storage to conclude that we cannot read it.
  if (row.size > TEXT_EXTRACT_MAX_BYTES) {
    await finishExtraction(row, { status: 'too_large', detail: `${row.size} bytes` }, log);
    return;
  }
  if (!canExtract(row.mime, row.filename)) {
    await finishExtraction(row, { status: 'unsupported', detail: row.mime }, log);
    return;
  }

  const store = blobstore();
  if (!store) return; // Storage vanished between the upload and now; leave the row `pending`.

  let buf: Buffer;
  try {
    buf = await readAll(await store.get(row.storageKey), TEXT_EXTRACT_MAX_BYTES);
  } catch (err) {
    // A bucket read failing is OUR fault, not the file's, so it is logged as an error as well as
    // recorded on the row — `failed` alone would send the user hunting for a corrupt document.
    log.error({ err, documentId: row.id }, 'could not read document bytes for extraction');
    await finishExtraction(row, { status: 'failed', detail: 'could not read the stored file' }, log);
    return;
  }

  await finishExtraction(row, await extractText(buf, row.mime, row.filename), log);
}

async function finishExtraction(
  row: DocumentRow & { storageKey: string },
  result: { status: string; text?: string; chars?: number; detail?: string },
  log: FastifyBaseLogger,
): Promise<void> {
  const [updated] = await db
    .update(schema.documents)
    .set({
      textStatus: result.status,
      textContent: result.text ?? null,
      textChars: result.chars ?? null,
      extractedAt: new Date(),
    })
    .where(eq(schema.documents.id, row.id))
    .returning();
  // The document was hard-deleted while we were parsing it (its board went away, most likely).
  if (!updated) return;

  if (result.status !== 'ok') {
    log.info({ documentId: row.id, status: result.status, detail: result.detail }, 'no text extracted');
  }
  // No actorId: extraction has no actor, and a client that skips its own echoes must not skip this.
  publish(boardChannel(updated.tabId), {
    v: 1,
    type: 'document',
    action: 'extracted',
    documentId: updated.id,
    document: await documentDTOWithCounts(updated),
  });
}

/** Buffer a stream, refusing to grow past `limit`. */
async function readAll(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    // Belt and braces: the caller already checked `documents.size`. This is what stops a row whose
    // size disagrees with its object from turning into unbounded memory.
    if (total > limit) {
      stream.destroy();
      throw new Error(`stored object exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // Registered inside this plugin's scope: no other route accepts multipart, and a global parser
  // would change how every existing endpoint treats an unexpected content type.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  });

  app.addHook('preHandler', requireAuth);

  // ---- upload ----------------------------------------------------------------
  app.post(
    '/api/boards/:id/documents',
    { preHandler: requireBoardRole('editor', paramTabId), config: { rateLimit: UPLOAD_RL } },
    async (req, reply) => {
      const store = blobstore();
      if (!store) return reply.code(503).send({ error: 'document storage is not configured' });

      const tabId = req.boardScope!;
      const userId = req.user!.id;
      const { taskId } = req.query as { taskId?: string };

      // Cheap pre-check. The real one runs after the upload, when the size is known — this only
      // avoids streaming a large file to a board that is already full.
      if ((await boardUsage(tabId)) >= BOARD_QUOTA_BYTES) {
        return reply.code(413).send({ error: 'board storage quota reached' });
      }

      // A task reference must belong to THIS board, or a document would be filed against work its
      // uploader may not be able to see.
      if (taskId) {
        const [task] = await db
          .select({ homeTabId: schema.tasks.homeTabId })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .limit(1);
        if (!task || task.homeTabId !== tabId) {
          return reply.code(400).send({ error: 'task is not on this board' });
        }
      }

      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'no file in request' });

      const filename = safeFilename(part.filename ?? 'download');
      // Opaque and random: nothing about the content leaks through the key, and two identical
      // uploads stay independent objects so deleting one can never strand the other.
      const storageKey = `doc/${nanoid(24)}`;
      const m = meter();
      let upload: Promise<void> | undefined;
      let feed: Promise<void> | undefined;

      try {
        // The object's own ContentType is left generic: downloads stream through this app and take
        // their Content-Type from the sniffed value on the row (D5), so the bucket's copy is never
        // what a browser sees. Revisit if presigned URLs ever ship.
        // Both run concurrently: put() consumes the meter while pipeline() feeds it. Held in
        // variables so that when one rejects, the other's rejection is still handled — an
        // unhandled one from the loser of that race would take the process down.
        upload = store.put(storageKey, m.stream, FALLBACK_MIME);
        feed = pipeline(part.file, m.stream);
        await Promise.all([upload, feed]);
      } catch (err) {
        upload?.catch(() => {});
        feed?.catch(() => {});
        const code = (err as { code?: string }).code;
        if (code === 'FILE_TOO_LARGE' || part.file.truncated) {
          await store.delete(storageKey).catch(() => {});
          return reply.code(413).send({ error: 'file too large' });
        }
        req.log.error({ err, storageKey }, 'document upload failed');
        await store.delete(storageKey).catch(() => {});
        return reply.code(502).send({ error: 'upload failed' });
      }

      // @fastify/multipart's own limit is a backstop for the meter above; it truncates rather than
      // throwing, so a file that trips it arrives intact-looking but short.
      if (part.file.truncated) {
        await store.delete(storageKey).catch(() => {});
        return reply.code(413).send({ error: 'file too large' });
      }

      const size = m.size();
      if ((await boardUsage(tabId)) + size > BOARD_QUOTA_BYTES) {
        await store.delete(storageKey).catch(() => {});
        return reply.code(413).send({ error: 'board storage quota reached' });
      }

      const mime = sniffMime(m.head(), filename);
      const id = nanoid();
      const [row] = await db
        .insert(schema.documents)
        .values({
          id,
          tabId,
          taskId: taskId ?? null,
          storageKey,
          filename,
          mime,
          size,
          sha256: m.digest(),
          uploadedBy: userId,
        })
        .returning();

      // A brand-new document has no items by construction, so this needs no query.
      const dto = documentDTO(row, NO_ITEMS);
      recordAudit({
        actorId: userId, action: 'document_upload', targetType: 'document', targetId: id,
        scopeId: tabId, method: 'POST', status: 200,
        payload: { filename, mime, size, taskId: taskId ?? null },
      });
      publish(boardChannel(tabId), { v: 1, type: 'document', action: 'create', document: dto, actorId: userId });
      startExtraction(row, req.log);
      return dto;
    },
  );

  // ---- list ------------------------------------------------------------------
  app.get(
    '/api/boards/:id/documents',
    { preHandler: requireBoardRole('viewer', paramTabId) },
    async (req) => {
      const tabId = req.boardScope!;
      const { taskId } = req.query as { taskId?: string };
      const where = [eq(schema.documents.tabId, tabId), isNull(schema.documents.deletedAt)];
      if (taskId) where.push(eq(schema.documents.taskId, taskId));
      const rows = await db
        .select()
        .from(schema.documents)
        .where(and(...where))
        .orderBy(desc(schema.documents.createdAt));
      const counts = await itemCountsFor(rows.map((r) => r.id));
      return { documents: rows.map((r) => documentDTO(r, counts.get(r.id) ?? NO_ITEMS)) };
    },
  );

  // ---- one document ----------------------------------------------------------
  app.get(
    '/api/documents/:id',
    { preHandler: requireBoardRole('viewer', documentBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { includeText } = req.query as { includeText?: string };

      const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
      if (!doc || doc.deletedAt) return reply.code(404).send({ error: 'not found' });

      const document = await documentDTOWithCounts(doc);
      // Opt-in, because the text can be a megabyte and the only surface that wants it is the
      // jump-to-context view behind a citation. Everything else reads textStatus/textChars.
      if (includeText !== '1' && includeText !== 'true') return { document };
      return { document, text: doc.textContent ?? undefined };
    },
  );

  // ---- download --------------------------------------------------------------
  app.get(
    '/api/documents/:id/content',
    { preHandler: requireBoardRole('viewer', documentBoard) },
    async (req, reply) => {
      const store = blobstore();
      if (!store) return reply.code(503).send({ error: 'document storage is not configured' });
      const { id } = req.params as { id: string };

      const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
      if (!doc || doc.deletedAt) return reply.code(404).send({ error: 'not found' });

      // Never the stored type verbatim: only a value from the allowlist reaches a browser, and
      // everything else degrades to octet-stream. Paired with `attachment` below.
      const type = SERVE_ALLOWLIST.has(doc.mime) ? doc.mime : FALLBACK_MIME;
      const ascii = safeFilename(doc.filename);
      reply
        .header('content-type', type)
        // ALWAYS attachment. The RFC 5987 filename* carries the real, possibly non-ASCII name;
        // the plain filename= is the ASCII fallback for clients that ignore it.
        .header(
          'content-disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
        )
        .header('content-length', String(doc.size));

      return reply.send(await store.get(doc.storageKey));
    },
  );

  // ---- delete (soft) ---------------------------------------------------------
  app.delete(
    '/api/documents/:id',
    { preHandler: requireBoardRole('editor', documentBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;
      const tabId = req.boardScope!;

      if (await restrictsDeleteToAdmin(tabId)) {
        if (!(await hasBoardRole(userId, tabId, 'admin'))) {
          return reply.code(403).send({ error: 'only an admin may delete on this board' });
        }
      }

      // The OBJECT is kept: Trash has to restore. The retention prune is what finally removes it.
      const [row] = await db
        .update(schema.documents)
        .set({ deletedAt: new Date(), deletedBy: userId })
        .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not found' });

      recordAudit({
        actorId: userId, action: 'document_delete', targetType: 'document', targetId: id,
        scopeId: tabId, method: 'DELETE', status: 200,
        payload: { filename: row.filename, size: row.size },
      });
      publish(boardChannel(tabId), { v: 1, type: 'document', action: 'delete', documentId: id, actorId: userId });
      return { ok: true };
    },
  );

  // ---- restore ---------------------------------------------------------------
  app.post(
    '/api/documents/:id/restore',
    { preHandler: requireBoardRole('editor', documentBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;
      const tabId = req.boardScope!;

      const [row] = await db
        .update(schema.documents)
        .set({ deletedAt: null, deletedBy: null })
        .where(eq(schema.documents.id, id))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not found' });

      // Items survive the trip through Trash with the row, so these are re-read rather than zeroed.
      const dto = await documentDTOWithCounts(row);
      recordAudit({
        actorId: userId, action: 'document_restore', targetType: 'document', targetId: id,
        scopeId: tabId, method: 'POST', status: 200,
      });
      publish(boardChannel(tabId), { v: 1, type: 'document', action: 'create', document: dto, actorId: userId });
      return dto;
    },
  );
}
