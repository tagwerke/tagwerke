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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId, restrictsDeleteToAdmin, hasBoardRole } from '../auth/boards.ts';
import { recordAudit } from '../lib/audit.ts';
import { publish, boardChannel } from '../lib/bus.ts';
import { blobstore } from '../lib/blobstore.ts';
import { sniffMime, safeFilename, SNIFF_BYTES, FALLBACK_MIME } from '../lib/mime.ts';

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
  uploadedBy: string | null;
  createdAt: Date;
}

function documentDTO(d: DocumentRow): Record<string, unknown> {
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
  };
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

      const dto = documentDTO(row);
      recordAudit({
        actorId: userId, action: 'document_upload', targetType: 'document', targetId: id,
        scopeId: tabId, method: 'POST', status: 200,
        payload: { filename, mime, size, taskId: taskId ?? null },
      });
      publish(boardChannel(tabId), { v: 1, type: 'document', action: 'create', document: dto, actorId: userId });
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
      return { documents: rows.map(documentDTO) };
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

      const dto = documentDTO(row);
      recordAudit({
        actorId: userId, action: 'document_restore', targetType: 'document', targetId: id,
        scopeId: tabId, method: 'POST', status: 200,
      });
      publish(boardChannel(tabId), { v: 1, type: 'document', action: 'create', document: dto, actorId: userId });
      return dto;
    },
  );
}
