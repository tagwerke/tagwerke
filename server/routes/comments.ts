// Comments on tasks (COMMENTS_PLAN.md). Rows, not document content — see the note on
// `task_comments` in db/schema.ts for why they are deliberately outside the Yjs doc.
//
// Roles (D6): `viewer` may READ and WRITE comments — read-only stakeholder feedback is most of
// the value of comments and the one genuinely useful thing a viewer can do. Editing is
// author-only (nobody rewrites someone else's words, admins included); deleting is author or
// board admin, and is soft (D7), so a thread never grows a hole.
//
// Every write records its own audit row (targetType 'task_comment', scoped to the board) and
// publishes a live frame on the board channel. Notification fan-out is §4 of the plan: mentions
// first, then the task's assignee/reviewer, deduped, actor always skipped.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, boardRole, hasBoardRole } from '../auth/boards.ts';
import { recordAudit } from '../lib/audit.ts';
import { notify } from '../lib/notify.ts';
import { publish, boardChannel } from '../lib/bus.ts';
import { mentionedUserIds, plainBody } from '../../shared/mentions.ts';

/** Bodies are plain text with mention tokens. Bounded so one comment can't be a document. */
const MAX_BODY = 10_000;

const createBody = z.object({
  // Client-generated so an outbox replay is idempotent (D8).
  id: z.string().min(1).max(64),
  body: z.string().min(1).max(MAX_BODY),
  parentCommentId: z.string().min(1).nullable().optional(),
});

const patchBody = z.object({
  body: z.string().min(1).max(MAX_BODY),
});

/** The board owning the task named in `:id` — but only while the task is live (not trashed). */
async function taskBoard(req: FastifyRequest): Promise<string | undefined> {
  const { id } = req.params as { id: string };
  const rows = await db
    .select({ homeTabId: schema.tasks.homeTabId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.deletedAt)))
    .limit(1);
  return rows[0]?.homeTabId;
}

/** The board owning the comment named in `:id`. Denormalized on the row, so one lookup. */
async function commentBoard(req: FastifyRequest): Promise<string | undefined> {
  const { id } = req.params as { id: string };
  const rows = await db
    .select({ tabId: schema.taskComments.tabId })
    .from(schema.taskComments)
    .where(eq(schema.taskComments.id, id))
    .limit(1);
  return rows[0]?.tabId;
}

type CommentRow = typeof schema.taskComments.$inferSelect;

/**
 * Wire shape of one comment. A soft-deleted comment keeps its place and its byline but sheds its
 * text: the tombstone is there to keep the conversation readable, not to publish what was
 * withdrawn. (`last_body` stays in the row for the audit trail — it is never sent to a client.)
 */
function commentDTO(row: CommentRow, authorEmail: string | null): Record<string, unknown> {
  const deleted = row.deletedAt != null;
  return {
    id: row.id,
    taskId: row.taskId,
    tabId: row.tabId,
    authorId: row.authorId,
    authorEmail,
    authorName: authorEmail ? authorEmail.split('@')[0] : null,
    parentCommentId: row.parentCommentId,
    body: deleted ? '' : row.body,
    mentions: deleted ? [] : ((row.mentions as string[] | null) ?? []),
    deleted,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  };
}

/** Resolve one comment's author email (for the byline) without a join on the write paths. */
async function authorEmailOf(authorId: string | null): Promise<string | null> {
  if (!authorId) return null;
  const rows = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, authorId)).limit(1);
  return rows[0]?.email ?? null;
}

/**
 * The mention list to store: the ids written in the body, minus anyone who is not a member of the
 * board. Re-derived on every write and never taken from the request (D5) — the set the server
 * notifies has to be exactly the set the reader can see was mentioned.
 */
async function resolveMentions(body: string, tabId: string): Promise<string[]> {
  const ids = mentionedUserIds(body);
  if (!ids.length) return [];
  const rows = await db
    .select({ userId: schema.boardMembers.userId })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.tabId, tabId), inArray(schema.boardMembers.userId, ids)));
  const members = new Set(rows.map((r) => r.userId));
  return ids.filter((id) => members.has(id));
}

/** Short single-line preview of a comment, for a notification body. */
function commentPreview(body: string): string {
  const s = plainBody(body).replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 99)}…` : s;
}

/** Broadcast a comment change to everyone with the board open (D2). */
function publishComment(tabId: string, action: 'create' | 'update' | 'delete', comment: Record<string, unknown>, actorId: string): void {
  publish(boardChannel(tabId), { v: 1, type: 'comment', action, comment, actorId });
}

/**
 * Per-task comment counts for a set of boards — what the board payload carries so the task rows
 * can show a badge (D9). Tombstones are excluded: a thread whose only comment was deleted reads
 * as having none, which is what the badge should say.
 */
export async function commentCountsForTabs(tabIds: string[]): Promise<Record<string, number>> {
  if (!tabIds.length) return {};
  const rows = await db
    .select({ taskId: schema.taskComments.taskId, count: sql<number>`count(*)::int` })
    .from(schema.taskComments)
    .where(and(inArray(schema.taskComments.tabId, tabIds), isNull(schema.taskComments.deletedAt)))
    .groupBy(schema.taskComments.taskId);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.taskId] = Number(r.count);
  return out;
}

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // The thread on one task, oldest first (a conversation reads forwards, unlike the history
  // timeline). Tombstones included so replies keep their context.
  app.get('/api/tasks/:id/comments', { preHandler: requireBoardRole('viewer', taskBoard) }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select({ c: schema.taskComments, email: schema.users.email })
      .from(schema.taskComments)
      .leftJoin(schema.users, eq(schema.users.id, schema.taskComments.authorId))
      .where(eq(schema.taskComments.taskId, id))
      .orderBy(asc(schema.taskComments.createdAt), asc(schema.taskComments.id));
    return { comments: rows.map((r) => commentDTO(r.c, r.email ?? null)) };
  });

  // Post a comment. Viewer+ (D6).
  app.post('/api/tasks/:id/comments', { preHandler: requireBoardRole('viewer', taskBoard) }, async (req, reply) => {
    const { id: taskId } = req.params as { id: string };
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid comment' });
    const tabId = req.boardScope!; // resolved by the preHandler from the live task
    const userId = req.user!.id;

    // A reply must belong to the same thread. Without this an id from another task would graft
    // a comment onto a conversation its author never saw.
    if (b.data.parentCommentId) {
      const parent = (
        await db
          .select({ taskId: schema.taskComments.taskId })
          .from(schema.taskComments)
          .where(eq(schema.taskComments.id, b.data.parentCommentId))
          .limit(1)
      )[0];
      if (!parent || parent.taskId !== taskId) return reply.code(400).send({ error: 'parent comment is not on this task' });
    }

    const mentions = await resolveMentions(b.data.body, tabId);
    const values = {
      id: b.data.id,
      taskId,
      tabId,
      authorId: userId,
      parentCommentId: b.data.parentCommentId ?? null,
      body: b.data.body,
      mentions,
      lastBody: b.data.body,
    };
    // Idempotent replay (D8): the same client id arriving twice is the outbox retrying, not a
    // second comment. DO NOTHING rather than update — a replay must not overwrite a later edit.
    await db.insert(schema.taskComments).values(values).onConflictDoNothing({ target: schema.taskComments.id });
    const row = (await db.select().from(schema.taskComments).where(eq(schema.taskComments.id, b.data.id)).limit(1))[0];
    if (!row) return reply.code(500).send({ error: 'comment not stored' });
    // A replayed insert that hit an existing row belonging to someone else is not ours to
    // report on — return it untouched and skip the notify/audit fan-out (already done once).
    const fresh = row.authorId === userId && row.body === b.data.body;

    const dto = commentDTO(row, await authorEmailOf(row.authorId));

    if (fresh) {
      req.auditHandled = true;
      recordAudit({
        actorId: userId, action: 'comment_create', targetType: 'task_comment', targetId: row.id,
        scopeId: tabId, method: 'POST', status: 200,
        payload: { taskId, parentCommentId: row.parentCommentId, mentions },
      });
      publishComment(tabId, 'create', dto, userId);
      await notifyForComment({ taskId, tabId, actorId: userId, body: row.body, mentions });
    }
    return reply.send({ ok: true, comment: dto });
  });

  // Edit a comment. Author only — an admin may remove someone's comment but never rewrite it.
  app.patch('/api/comments/:id', { preHandler: requireBoardRole('viewer', commentBoard) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid comment' });
    const before = (await db.select().from(schema.taskComments).where(eq(schema.taskComments.id, id)).limit(1))[0];
    if (!before) return reply.code(404).send({ error: 'not found' });
    if (before.deletedAt) return reply.code(400).send({ error: 'comment was deleted' });
    if (before.authorId !== req.user!.id) return reply.code(403).send({ error: 'only the author can edit a comment' });

    const mentions = await resolveMentions(b.data.body, before.tabId);
    await db
      .update(schema.taskComments)
      .set({ body: b.data.body, lastBody: b.data.body, mentions, editedAt: new Date() })
      .where(eq(schema.taskComments.id, id));
    const row = { ...before, body: b.data.body, mentions, editedAt: new Date() };
    const dto = commentDTO(row, await authorEmailOf(row.authorId));

    req.auditHandled = true;
    recordAudit({
      actorId: req.user!.id, action: 'comment_edit', targetType: 'task_comment', targetId: id,
      scopeId: before.tabId, method: 'PATCH', status: 200,
      // The previous text is the point of the row: an edited comment's history is the only way
      // to see what a reader was replying to.
      payload: { taskId: before.taskId, from: before.body, to: b.data.body },
    });
    publishComment(before.tabId, 'update', dto, req.user!.id);
    // Deliberately no notification on an edit (§4) — only a new comment is news.
    return reply.send({ ok: true, comment: dto });
  });

  // Soft-delete a comment. Author, or a board admin.
  app.delete('/api/comments/:id', { preHandler: requireBoardRole('viewer', commentBoard) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const before = (await db.select().from(schema.taskComments).where(eq(schema.taskComments.id, id)).limit(1))[0];
    if (!before) return reply.code(404).send({ error: 'not found' });
    const userId = req.user!.id;
    const isAuthor = before.authorId === userId;
    if (!isAuthor && !(await hasBoardRole(userId, before.tabId, 'admin')))
      return reply.code(403).send({ error: 'only the author or a board admin can delete a comment' });
    if (before.deletedAt) return reply.send({ ok: true }); // already gone — idempotent

    const deletedAt = new Date();
    await db
      .update(schema.taskComments)
      // `body` is cleared but `last_body` (written on every create/edit) keeps the text for the
      // audit trail. Clearing `mentions` too so a withdrawn comment stops implicating anyone.
      .set({ deletedAt, deletedBy: userId, body: '', mentions: [] })
      .where(eq(schema.taskComments.id, id));
    const dto = commentDTO({ ...before, deletedAt, deletedBy: userId, body: '' }, await authorEmailOf(before.authorId));

    req.auditHandled = true;
    recordAudit({
      actorId: userId, action: 'comment_delete', targetType: 'task_comment', targetId: id,
      scopeId: before.tabId, method: 'DELETE', status: 200,
      payload: { taskId: before.taskId, byAuthor: isAuthor, body: before.body },
    });
    publishComment(before.tabId, 'delete', dto, userId);
    return reply.send({ ok: true });
  });
}

/**
 * Fan a new comment out to the people it concerns (§4):
 *
 *   1. everyone mentioned in it   → `comment_mention`
 *   2. the task's assignee + reviewer → `comment_added`
 *
 * Deduped, and the actor never notifies themselves. A mention WINS over the assignee/reviewer
 * kind for someone who qualifies twice — it is the more specific and more actionable framing.
 *
 * NOT included, deliberately: everyone who previously commented on the task. Thread-wide fan-out
 * is how comment systems become noise, and there is no per-thread mute yet to relieve it.
 */
async function notifyForComment(input: {
  taskId: string;
  tabId: string;
  actorId: string;
  body: string;
  mentions: string[];
}): Promise<void> {
  const task = (
    await db
      .select({ text: schema.tasks.text, assigneeId: schema.tasks.assigneeId, reviewerId: schema.tasks.reviewerId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, input.taskId))
      .limit(1)
  )[0];
  if (!task) return;

  const preview = commentPreview(input.body);
  const label = (task.text ?? '').trim() || 'a task';
  const sent = new Set<string>([input.actorId]);

  for (const userId of input.mentions) {
    if (sent.has(userId)) continue;
    sent.add(userId);
    notify(userId, {
      type: 'comment_mention',
      title: `Mentioned you on “${label.length > 60 ? `${label.slice(0, 59)}…` : label}”`,
      body: preview,
      tabId: input.tabId,
      actorId: input.actorId,
    });
  }

  for (const userId of [task.assigneeId, task.reviewerId]) {
    if (!userId || sent.has(userId)) continue;
    // A recipient who has since lost access to the board must not be told what was said on it.
    if (!(await boardRole(userId, input.tabId))) continue;
    sent.add(userId);
    notify(userId, {
      type: 'comment_added',
      title: `New comment on “${label.length > 60 ? `${label.slice(0, 59)}…` : label}”`,
      body: preview,
      tabId: input.tabId,
      actorId: input.actorId,
    });
  }
}
