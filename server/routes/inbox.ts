// Email→task confirm queue ("Inbox"). Step 1: a dev/test ingest endpoint that
// takes raw email text, runs Haiku extraction, and lands a DRAFT the user
// approves. Plus the queue API: list pending, keep (-> real task), dismiss.
//
// The email body is read in-memory for extraction and never stored — only the
// extracted result + lightweight metadata are persisted (see schema.inboundDrafts).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { extractTask, type ExtractedTask } from '../lib/extractTask.ts';

const ingestBody = z.object({
  from: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1),
});

// The task itself is created client-side through the normal doc/persist path
// (which enforces board edit permission via /api/tasks). Keep just records the
// decision and the resulting task id for provenance.
const keepBody = z.object({ keptTaskId: z.string().optional() });

/** Persist an extracted task as a pending draft. Returns the new draft id. */
async function createDraft(
  userId: string,
  ex: ExtractedTask,
  meta: { from?: string; subject?: string; snippet: string },
  extractionFailed = false,
): Promise<string> {
  const id = `d_${nanoid(8)}`;
  await db.insert(schema.inboundDrafts).values({
    id,
    userId,
    status: 'pending',
    title: ex.title || meta.subject || '(untitled)',
    summary: ex.summary ?? null,
    suggestedDate: ex.dueDate ?? null,
    suggestedOwner: ex.owner ?? null,
    confidence: ex.confidence ?? null,
    fromAddr: meta.from ?? null,
    subject: meta.subject ?? null,
    snippet: meta.snippet,
    extractionFailed,
  });
  return id;
}

export async function inboxRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Dev/test ingest: paste raw email text, see what the AI extracts, and (if it
  // judges the email actionable) get a draft in your queue. No SMTP/DNS needed.
  app.post('/api/inbox/ingest-test', async (req, reply) => {
    const b = ingestBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid email' });
    const userId = req.user!.id;
    const snippet = b.data.body.replace(/\s+/g, ' ').trim().slice(0, 200);

    let ex: ExtractedTask;
    try {
      ex = await extractTask(b.data);
    } catch (err) {
      req.log.error({ err }, 'extraction failed');
      // Degrade gracefully: still queue the email by subject so nothing is lost.
      const fallback: ExtractedTask = {
        hasTask: true,
        title: b.data.subject || '(could not read email)',
        summary: snippet,
        dueDate: null,
        owner: null,
        confidence: 0,
      };
      const draftId = await createDraft(userId, fallback, { ...b.data, snippet }, true);
      return reply.send({ extracted: fallback, draftId, extractionFailed: true });
    }

    // Only actionable emails become drafts; non-tasks are reported but not queued.
    const draftId = ex.hasTask ? await createDraft(userId, ex, { ...b.data, snippet }) : null;
    return reply.send({ extracted: ex, draftId });
  });

  // List the user's pending drafts (newest first).
  app.get('/api/inbox', async (req, reply) => {
    const userId = req.user!.id;
    const rows = await db
      .select()
      .from(schema.inboundDrafts)
      .where(and(eq(schema.inboundDrafts.userId, userId), eq(schema.inboundDrafts.status, 'pending')))
      .orderBy(desc(schema.inboundDrafts.receivedAt));
    return reply.send({ drafts: rows });
  });

  // Keep a draft: mark it kept (the task was created client-side). Only the
  // owner can keep their own pending draft.
  app.post('/api/inbox/:id/keep', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = keepBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const userId = req.user!.id;
    const res = await db
      .update(schema.inboundDrafts)
      .set({ status: 'kept', keptTaskId: b.data.keptTaskId ?? null })
      .where(
        and(
          eq(schema.inboundDrafts.id, id),
          eq(schema.inboundDrafts.userId, userId),
          eq(schema.inboundDrafts.status, 'pending'),
        ),
      )
      .returning({ id: schema.inboundDrafts.id });
    if (!res.length) return reply.code(404).send({ error: 'draft not found or already resolved' });
    return reply.send({ ok: true });
  });

  // Dismiss a draft (no task created).
  app.post('/api/inbox/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const res = await db
      .update(schema.inboundDrafts)
      .set({ status: 'dismissed' })
      .where(and(eq(schema.inboundDrafts.id, id), eq(schema.inboundDrafts.userId, userId)))
      .returning({ id: schema.inboundDrafts.id });
    if (!res.length) return reply.code(404).send({ error: 'draft not found' });
    return reply.send({ ok: true });
  });
}
