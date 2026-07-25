import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, boardRole, hasBoardRole, restrictsDeleteToAdmin, boardRequiresReview, paramTabId } from '../auth/boards.ts';
import { auditEdit, diffChanges, recordAudit } from '../lib/audit.ts';
import { notify } from '../lib/notify.ts';
import { reconcileBoard } from '../realtime/ydoc.ts';
import { isValidRank, rankAfter } from '../../shared/rank.ts';
import { MAX_TASK_DEPTH } from '../../shared/tree.ts';

/** Sibling order key. Validated on the way in — a malformed rank would corrupt every view's order
 *  silently, and it costs nothing to reject it at the edge. See shared/rank.ts. */
const rankField = z.string().refine(isValidRank, 'malformed rank').nullable().optional();

/** Short, single-line label of a task for a notification body. */
function taskLabel(text: string | null | undefined): string {
  const s = (text ?? '').trim();
  if (!s) return 'A task';
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** Fire an "assigned to you" notification when assignment changed to a real, different user.
 *  Shared by PUT and PATCH — the two paths that ever set assigneeId (see NOTIFICATIONS.md §2). */
function notifyAssigneeChange(
  nextAssignee: string | null | undefined,
  prevAssignee: string | null | undefined,
  actorId: string,
  tabId: string,
  text: string | null | undefined,
): void {
  if (!nextAssignee || nextAssignee === prevAssignee || nextAssignee === actorId) return;
  notify(nextAssignee, { type: 'task_assigned', title: 'Assigned to you', body: taskLabel(text), tabId, actorId });
}

// Fields whose changes are worth an accountability trail. `rank` is excluded (reorder
// noise); `done`/`owner` are derived/legacy. `parentTaskId` IS audited — re-parenting moves a task
// between deliverables, which is a structural change, not reorder noise (SUBTASKS_PLAN P1.3).
// See AUDIT_IMPLEMENTATION_PLAN §B2.
const AUDITED_FIELDS = ['text', 'status', 'assigneeId', 'reviewerId', 'date', 'priority', 'parentTaskId'] as const;

/** Resolve a task's home board (for routes whose body doesn't carry it). */
async function taskBoard(req: FastifyRequest): Promise<string | undefined> {
  const { id } = req.params as { id: string };
  const rows = await db
    .select({ homeTabId: schema.tasks.homeTabId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .limit(1);
  return rows[0]?.homeTabId;
}

export const priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const statusEnum = z.enum(['todo', 'in_progress', 'in_review', 'done', 'cancelled']);

const upsertBody = z.object({
  homeTabId: z.string().min(1),
  text: z.string(),
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
  reviewerId: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  priority: priority.nullable().optional(),
  rank: rankField,
  parentTaskId: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  done: z.boolean().optional(),
});

const patchBody = z.object({
  text: z.string().optional(),
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
  reviewerId: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  priority: priority.nullable().optional(),
  rank: rankField,
  parentTaskId: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  done: z.boolean().optional(),
});

const orphanBody = z.object({
  homeTabId: z.string().min(1),
  keepIds: z.array(z.string().min(1)),
});

// `done` is a derived back-compat mirror of status==='done' (see schema + SPEC §3).
// `owner` is the legacy free-text display fallback; `assigneeId` is the real assignment and,
// when set, is constrained to a member of the task's home board (SPEC §5).

/** True when `assigneeId` is null/undefined or names a member of `homeTabId`. */
async function assigneeAllowed(homeTabId: string, assigneeId: string | null | undefined): Promise<boolean> {
  if (assigneeId == null) return true;
  return (await boardRole(assigneeId, homeTabId)) != null;
}

/**
 * The rank a new task should get when the client didn't supply one: after the current last sibling.
 * Keeps the invariant "every row has a rank" true without a repair pass, so an older client, the
 * server-side doc backfill, or an import can all create tasks that still land in a sensible place.
 * The ORDER BY is safe because the column is COLLATE "C" — the DB's string order is byte order,
 * the same order shared/rank.ts assumes.
 */
async function nextSiblingRank(homeTabId: string, parentTaskId: string | null): Promise<string> {
  const rows = await db
    .select({ rank: schema.tasks.rank })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.homeTabId, homeTabId),
        parentTaskId == null ? isNull(schema.tasks.parentTaskId) : eq(schema.tasks.parentTaskId, parentTaskId),
        isNotNull(schema.tasks.rank),
      ),
    )
    .orderBy(desc(schema.tasks.rank))
    .limit(1);
  return rankAfter(rows[0]?.rank ?? null);
}

/**
 * Every LIVE descendant of `id`, deepest-last. The unit that delete and restore operate on
 * (SUBTASKS_PLAN D7): a parent is a commitment and its sub-tasks are the work under it, so
 * trashing the commitment has to take the work with it — otherwise the children survive pointing
 * at a row that no longer renders, which is how you get tasks nobody can reach.
 * Bounded by the depth limit so a pre-existing cycle can't spin.
 */
async function liveDescendantIds(id: string): Promise<string[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE descn AS (
      SELECT id, 0 AS d FROM tasks WHERE id = ${id}
      UNION ALL
      SELECT t.id, descn.d + 1
        FROM tasks t JOIN descn ON t.parent_task_id = descn.id
       WHERE descn.d < ${MAX_TASK_DEPTH + 1} AND t.deleted_at IS NULL
    )
    SELECT id FROM descn WHERE d > 0
  `);
  return ((res.rows ?? res) as { id: string }[]).map((r) => r.id);
}

/**
 * Descendants of `id` that were trashed in the SAME sweep — i.e. share its `deleted_at`. Restore
 * uses this rather than "all trashed descendants" so it undoes exactly the delete it is reversing:
 * a child trashed separately, earlier, stays in the Trash where its owner put it.
 */
async function coDeletedDescendantIds(id: string, deletedAt: Date): Promise<string[]> {
  const res = await db.execute(sql`
    WITH RECURSIVE descn AS (
      SELECT id, 0 AS d FROM tasks WHERE id = ${id}
      UNION ALL
      SELECT t.id, descn.d + 1
        FROM tasks t JOIN descn ON t.parent_task_id = descn.id
       WHERE descn.d < ${MAX_TASK_DEPTH + 1} AND t.deleted_at = ${deletedAt}
    )
    SELECT id FROM descn WHERE d > 0
  `);
  return ((res.rows ?? res) as { id: string }[]).map((r) => r.id);
}

/** Why a proposed re-parent was refused — turned into a specific 400 so the client can say which. */
type ParentRefusal = 'not-found' | 'other-board' | 'cycle' | 'too-deep';

const PARENT_REFUSAL_MESSAGE: Record<ParentRefusal, string> = {
  'not-found': 'parent task does not exist',
  'other-board': 'parent task is not on the home board',
  cycle: 'a task cannot be nested under its own descendant',
  'too-deep': `sub-tasks may not nest more than ${MAX_TASK_DEPTH} levels deep`,
};

/**
 * Validate a proposed parent for task `id`, in ONE round trip (SUBTASKS_PLAN D9).
 *
 * Three things have to hold and all three are answered by the same pair of recursive walks:
 *   - the parent is on the same board (also a DB constraint since 0026, but a friendly 400 beats
 *     a constraint violation surfacing as a 500);
 *   - the parent is not `id` itself nor any of `id`'s own descendants — otherwise the two form a
 *     cycle that no tree walk can terminate on. The previous check only caught direct
 *     self-parenting, so A→B→A was reachable in two PATCHes;
 *   - the deepest leaf of the moved subtree still fits under MAX_TASK_DEPTH. Checking the moved
 *     task alone is not enough: nesting a task that already has two levels beneath it is what
 *     actually busts the limit.
 *
 * Both walks are bounded by the depth limit, so they terminate even on data that is already
 * cyclic (an old row written before this check existed).
 */
async function parentRefusal(
  homeTabId: string,
  id: string,
  parentTaskId: string | null | undefined,
): Promise<ParentRefusal | null> {
  if (parentTaskId == null) return null;
  if (parentTaskId === id) return 'cycle';

  // `anc`   — the parent and its ancestors, nearest first (d = 1 is the parent itself).
  // `descn` — the moved task and everything under it (d = 0 is the task itself).
  const bound = MAX_TASK_DEPTH + 2; // walk one past the limit so "too deep" is detectable
  const res = await db.execute(sql`
    WITH RECURSIVE anc AS (
      SELECT id, parent_task_id, home_tab_id, 1 AS d
        FROM tasks WHERE id = ${parentTaskId}
      UNION ALL
      SELECT t.id, t.parent_task_id, t.home_tab_id, anc.d + 1
        FROM tasks t JOIN anc ON t.id = anc.parent_task_id
       WHERE anc.d < ${bound}
    ),
    descn AS (
      SELECT id, 0 AS d FROM tasks WHERE id = ${id}
      UNION ALL
      SELECT t.id, descn.d + 1
        FROM tasks t JOIN descn ON t.parent_task_id = descn.id
       WHERE descn.d < ${bound} AND t.deleted_at IS NULL
    )
    SELECT
      (SELECT home_tab_id FROM anc WHERE d = 1)        AS parent_board,
      (SELECT max(d) FROM anc)                          AS parent_chain,
      (SELECT bool_or(id = ${id}) FROM anc)             AS creates_cycle,
      (SELECT coalesce(max(d), 0) FROM descn)           AS subtree_height
  `);
  const row = (res.rows ?? res)[0] as
    | { parent_board: string | null; parent_chain: number | null; creates_cycle: boolean | null; subtree_height: number | null }
    | undefined;

  if (!row || row.parent_board == null) return 'not-found';
  if (row.parent_board !== homeTabId) return 'other-board';
  if (row.creates_cycle) return 'cycle';
  // parent_chain is the parent's own 1-based chain length, which is exactly the depth the child
  // would land at; add the height of the subtree travelling with it.
  const deepest = Number(row.parent_chain ?? 1) + Number(row.subtree_height ?? 0);
  if (deepest > MAX_TASK_DEPTH) return 'too-deep';
  return null;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Editor on the TARGET board (body.homeTabId): you can only place a task in a board
  // you can edit.
  app.put(
    '/api/tasks/:id',
    { preHandler: requireBoardRole('editor', (req) => (req.body as { homeTabId?: string })?.homeTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = upsertBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid task' });
      if (!(await assigneeAllowed(b.data.homeTabId, b.data.assigneeId)))
        return reply.code(400).send({ error: 'assignee is not a member of the home board' });
      if (!(await assigneeAllowed(b.data.homeTabId, b.data.reviewerId)))
        return reply.code(400).send({ error: 'reviewer is not a member of the home board' });
      const putRefusal = await parentRefusal(b.data.homeTabId, id, b.data.parentTaskId);
      if (putRefusal) return reply.code(400).send({ error: PARENT_REFUSAL_MESSAGE[putRefusal] });
      const userId = req.user!.id;
      // status is authoritative; `done` is the derived back-compat mirror.
      const status = b.data.status ?? (b.data.done ? 'done' : 'todo');
      // Prior row (if any): distinguishes create vs replace for the audit trail.
      const before = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1))[0];
      // Cross-board hijack guard: this is an upsert on a client-supplied id, and the conflict path
      // rewrites homeTabId. The preHandler only proved editor on the TARGET board — so without this,
      // anyone with editor on any board could overwrite/steal any task by id (task ids are not
      // secret) by re-homing it to their own board. A legitimate cross-board move requires editor on
      // the board the task is LEAVING too; deny otherwise. 404 (not 403) keeps a board you can't see
      // non-probeable, matching auth/boards.ts.
      if (before && before.homeTabId !== b.data.homeTabId && !(await hasBoardRole(userId, before.homeTabId, 'editor')))
        return reply.code(404).send({ error: 'not found' });
      // requireReview guardrail (§F): on a review-required board, `done` is reachable only via the
      // in_review → done approval — never a direct jump (including creating a task straight to done).
      // An already-done task re-written by a full-sync/move keeps passing (before.status === 'done').
      if (status === 'done' && before?.status !== 'in_review' && before?.status !== 'done'
          && (await boardRequiresReview(b.data.homeTabId)))
        return reply.code(403).send({ error: 'this board requires review before a task can be marked done' });
      const hasTitle = b.data.text.trim().length > 0;
      // Sibling order: an explicit rank wins; otherwise KEEP the existing one (a PUT that omits it
      // must never wipe the ordering — the resurrect path and older clients both do that); and only
      // if there is none at all do we assign an append-position key.
      const rank = b.data.rank ?? before?.rank ?? (await nextSiblingRank(b.data.homeTabId, b.data.parentTaskId ?? null));
      const values = {
        id,
        createdBy: userId,
        homeTabId: b.data.homeTabId,
        text: b.data.text,
        status,
        assigneeId: b.data.assigneeId ?? null,
        reviewerId: b.data.reviewerId ?? null,
        date: b.data.date ?? null,
        priority: b.data.priority ?? null,
        rank,
        parentTaskId: b.data.parentTaskId ?? null,
        owner: b.data.owner ?? null,
        done: status === 'done',
        // Retain a recognizable Trash label; null only when genuinely never titled (§G).
        lastTitle: hasTitle ? b.data.text : null,
      };
      const onConflictSet: Record<string, unknown> = {
        homeTabId: values.homeTabId,
        text: values.text,
        status: values.status,
        assigneeId: values.assigneeId,
        reviewerId: values.reviewerId,
        date: values.date,
        priority: values.priority,
        rank: values.rank,
        parentTaskId: values.parentTaskId,
        owner: values.owner,
        done: values.done,
        // Resurrect: re-adding a task (e.g. editor undo / re-typing a line) clears any
        // soft-delete, so Ctrl+Z restores it in place. See AUDIT_IMPLEMENTATION_PLAN §H.
        deletedAt: null,
        deletedBy: null,
      };
      // Only advance last_title on non-empty text; emptying must never erase it.
      if (hasTitle) onConflictSet.lastTitle = b.data.text;
      await db.insert(schema.tasks).values(values).onConflictDoUpdate({ target: schema.tasks.id, set: onConflictSet });
      // Attribution: diff a replace; record a create when the task is new.
      if (before) {
        const changes = diffChanges(before as Record<string, unknown>, values, [...AUDITED_FIELDS, 'homeTabId']);
        auditEdit(req, { action: 'PUT /api/tasks/:id', targetType: 'task', targetId: id, scopeId: values.homeTabId, changes });
      } else {
        req.auditHandled = true;
        recordAudit({
          actorId: userId, action: 'PUT /api/tasks/:id', targetType: 'task', targetId: id,
          scopeId: values.homeTabId, method: 'PUT', status: 200,
          payload: { created: { text: values.text, status: values.status } },
        });
      }
      // Notify a newly-assigned user — covers "create a task already assigned to someone" (which
      // lands here, not on PATCH) and a full-replace that changes the assignee.
      notifyAssigneeChange(values.assigneeId, before?.assigneeId, userId, values.homeTabId, values.text);
      return reply.send({ ok: true });
    },
  );

  app.patch(
    '/api/tasks/:id',
    { preHandler: requireBoardRole('editor', taskBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = patchBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
      // Read the current row once: needed for membership scope, field diffs, and approval.
      const before = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1))[0];
      if (!before) return reply.code(404).send({ error: 'not found' });
      const homeTabId = before.homeTabId;
      // Enforce assignee/reviewer membership against the task's own home board.
      if (b.data.assigneeId != null && !(await assigneeAllowed(homeTabId, b.data.assigneeId)))
        return reply.code(400).send({ error: 'assignee is not a member of the home board' });
      if (b.data.reviewerId != null && !(await assigneeAllowed(homeTabId, b.data.reviewerId)))
        return reply.code(400).send({ error: 'reviewer is not a member of the home board' });
      if (b.data.parentTaskId !== undefined) {
        const refusal = await parentRefusal(homeTabId, id, b.data.parentTaskId);
        if (refusal) return reply.code(400).send({ error: PARENT_REFUSAL_MESSAGE[refusal] });
      }
      // requireReview guardrail (§F): on a review-required board, `done` is reachable only via the
      // in_review → done approval (the `approving` capture below). Reject a direct jump; an already-
      // done task (idempotent re-write) still passes.
      if (b.data.status === 'done' && before.status !== 'in_review' && before.status !== 'done'
          && (await boardRequiresReview(homeTabId)))
        return reply.code(403).send({ error: 'this board requires review before a task can be marked done' });

      // Keep the derived `done` mirror in sync whenever status is patched.
      const set = { ...b.data } as Record<string, unknown>;
      if (b.data.status !== undefined) set.done = b.data.status === 'done';
      // Retain the last non-empty title for Trash; emptying the text never clears it (§G).
      if (typeof b.data.text === 'string' && b.data.text.trim().length > 0) set.lastTitle = b.data.text;
      // Approval capture (F3): the in_review → done transition stamps the approver.
      const approving = b.data.status === 'done' && before.status === 'in_review';
      if (approving) {
        set.approvedBy = req.user!.id;
        set.approvedAt = new Date();
      }
      // Re-parented without a new rank: the old key was ordered against a DIFFERENT set of
      // siblings, so it means nothing under the new parent. Give it an append position there.
      if (b.data.parentTaskId !== undefined && b.data.rank === undefined && b.data.parentTaskId !== before.parentTaskId) {
        set.rank = await nextSiblingRank(homeTabId, b.data.parentTaskId ?? null);
      }
      await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id));

      // Enriched audit: field diffs, plus an explicit approval row for legibility.
      const changes = diffChanges(before as Record<string, unknown>, b.data as Record<string, unknown>, AUDITED_FIELDS);
      auditEdit(req, { action: 'PATCH /api/tasks/:id', targetType: 'task', targetId: id, scopeId: homeTabId, changes });
      if (approving) {
        recordAudit({
          actorId: req.user!.id, action: 'task_approved', targetType: 'task', targetId: id,
          scopeId: homeTabId, method: 'PATCH', status: 200, payload: { reviewerId: before.reviewerId ?? null },
        });
      }

      // Notifications (NOTIFICATIONS.md §2). All key off before/after we already have in hand.
      const actor = req.user!.id;
      const text = typeof b.data.text === 'string' ? b.data.text : before.text;
      // Assigned to you — assignment changed to a real, different user.
      notifyAssigneeChange(b.data.assigneeId, before.assigneeId, actor, homeTabId, text);
      // Review requested — the task just transitioned INTO in_review and has a reviewer.
      const reviewerId = b.data.reviewerId ?? before.reviewerId;
      if (b.data.status === 'in_review' && before.status !== 'in_review' && reviewerId && reviewerId !== actor) {
        notify(reviewerId, { type: 'review_requested', title: 'Review requested', body: taskLabel(text), tabId: homeTabId, actorId: actor });
      }
      // Approved — the reviewer signed off (in_review → done). Tell whoever did the work.
      if (approving) {
        const recipient = before.assigneeId ?? before.createdBy;
        if (recipient && recipient !== actor) {
          notify(recipient, { type: 'task_approved', title: 'Task approved', body: taskLabel(text), tabId: homeTabId, actorId: actor });
        }
      }
      return reply.send({ ok: true });
    },
  );

  app.delete(
    '/api/tasks/:id',
    { preHandler: requireBoardRole('editor', taskBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;
      // Read before deleting: needed for the restrict-delete check and the audit snapshot.
      const t = (await db
        .select({ homeTabId: schema.tasks.homeTabId, text: schema.tasks.text, status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .limit(1))[0];
      if (!t) return reply.send({ ok: true }); // already gone — nothing to audit
      // Opt-in preventive control (F4): some boards restrict deletion to admins.
      if ((await restrictsDeleteToAdmin(t.homeTabId)) && !(await hasBoardRole(userId, t.homeTabId, 'admin')))
        return reply.code(403).send({ error: 'only admins may delete on this board' });

      // Soft delete: trash the row (recoverable) instead of destroying it (§G). Idempotent.
      // The whole SUBTREE goes together (D7) and shares one deleted_at timestamp, which is what
      // lets restore put back exactly this delete and nothing else.
      const kids = await liveDescendantIds(id);
      const deletedAt = new Date();
      await db
        .update(schema.tasks)
        .set({ deletedAt, deletedBy: userId })
        .where(and(inArray(schema.tasks.id, [id, ...kids]), isNull(schema.tasks.deletedAt)));
      // Snapshot the title so the trail reads "deleted 'Buy milk'". One row for the whole subtree,
      // carrying the descendant count — deleting a deliverable is one act, not N.
      req.auditHandled = true;
      recordAudit({
        actorId: userId, action: 'DELETE /api/tasks/:id', targetType: 'task', targetId: id,
        scopeId: t.homeTabId, method: 'DELETE', status: 200,
        payload: { snapshot: { text: t.text, status: t.status }, ...(kids.length ? { subtaskCount: kids.length } : {}) },
      });
      return reply.send({ ok: true, subtaskCount: kids.length });
    },
  );

  app.post(
    '/api/tasks/delete-orphans',
    { preHandler: requireBoardRole('editor', (req) => (req.body as { homeTabId?: string })?.homeTabId) },
    async (req, reply) => {
      const b = orphanBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid request' });
      const userId = req.user!.id;
      // Opt-in preventive control (F4): mirror the single-delete guard so this bulk path can't be
      // used to mass-delete on a board that restricts deletion to admins.
      if ((await restrictsDeleteToAdmin(b.data.homeTabId)) && !(await hasBoardRole(userId, b.data.homeTabId, 'admin')))
        return reply.code(403).send({ error: 'only admins may delete on this board' });
      // Soft delete orphans (tasks no longer in the doc) — recoverable, not destroyed (§G).
      const conds = [eq(schema.tasks.homeTabId, b.data.homeTabId), isNull(schema.tasks.deletedAt)];
      if (b.data.keepIds.length) conds.push(notInArray(schema.tasks.id, b.data.keepIds));
      await db.update(schema.tasks).set({ deletedAt: new Date(), deletedBy: userId }).where(and(...conds));
      return reply.send({ ok: true });
    },
  );

  // Restore a trashed task (editor+ on its board). Idempotent. See §G/§H.
  app.post(
    '/api/tasks/:id/restore',
    { preHandler: requireBoardRole('editor', taskBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const trashed = (await db
        .select({ deletedAt: schema.tasks.deletedAt, parentTaskId: schema.tasks.parentTaskId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .limit(1))[0];
      if (!trashed) return reply.code(404).send({ error: 'not found' });

      // Bring back the subtree this delete took, and nothing else: only descendants that share
      // this row's deleted_at were trashed by the same act (D7). A child someone trashed
      // separately, earlier, stays in the Trash where they left it.
      const kids = trashed.deletedAt ? await coDeletedDescendantIds(id, trashed.deletedAt) : [];

      // If the parent is itself still trashed, restoring under it would put the task somewhere
      // invisible. Promote it to a root instead, with an append rank among the existing roots —
      // the same rule the retention prune's ON DELETE SET NULL follows.
      const set: Record<string, unknown> = { deletedAt: null, deletedBy: null };
      if (trashed.parentTaskId) {
        const parent = (await db
          .select({ deletedAt: schema.tasks.deletedAt })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, trashed.parentTaskId))
          .limit(1))[0];
        if (!parent || parent.deletedAt) {
          set.parentTaskId = null;
          if (req.boardScope) set.rank = await nextSiblingRank(req.boardScope, null);
        }
      }
      await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id));
      if (kids.length) {
        await db.update(schema.tasks).set({ deletedAt: null, deletedBy: null }).where(inArray(schema.tasks.id, kids));
      }
      // The row is live again, but the doc lost its ref when the task was deleted. Reconcile
      // re-adds the id-only ref so the task reappears on the board (TASKS_AS_ENTITIES.md P4 —
      // this is THE restore fix). Only roots get a ref now (D2), so a restored SUB-task reappears
      // by virtue of its parent's node view rendering it, not by regaining a node of its own.
      // Best-effort: if it fails, a later board-open reconcile heals it.
      if (req.boardScope) {
        try {
          await reconcileBoard(req.boardScope);
        } catch (err) {
          req.log.error({ err, tabId: req.boardScope }, 'restore: board reconcile failed');
        }
      }
      req.auditHandled = true;
      recordAudit({
        actorId: req.user!.id, action: 'task_restore', targetType: 'task', targetId: id,
        scopeId: req.boardScope ?? null, method: 'POST', status: 200,
        payload: {
          ...(kids.length ? { subtaskCount: kids.length } : {}),
          ...(set.parentTaskId === null ? { promotedToRoot: true } : {}),
        },
      });
      return reply.send({ ok: true, subtaskCount: kids.length });
    },
  );

  // Trash: a board's soft-deleted tasks (editor+). Powers the Trash view / restore surface.
  app.get(
    '/api/tabs/:id/trash',
    { preHandler: requireBoardRole('editor', paramTabId) },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await db
        .select({
          id: schema.tasks.id,
          text: schema.tasks.text,
          lastTitle: schema.tasks.lastTitle,
          status: schema.tasks.status,
          assigneeId: schema.tasks.assigneeId,
          deletedAt: schema.tasks.deletedAt,
          deletedBy: schema.tasks.deletedBy,
          deleterEmail: schema.users.email,
        })
        .from(schema.tasks)
        .leftJoin(schema.users, eq(schema.users.id, schema.tasks.deletedBy))
        .where(and(eq(schema.tasks.homeTabId, id), isNotNull(schema.tasks.deletedAt)))
        .orderBy(desc(schema.tasks.deletedAt))
        .limit(200);
      return { tasks: rows.map((r) => ({ ...r, deletedAt: r.deletedAt?.toISOString() ?? null })) };
    },
  );
}
