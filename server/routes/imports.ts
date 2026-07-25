// CSV importer (internal/planning/SPRINT_PLAN.md Sprint 3) — the first adapter of a shared
// import pipeline (Jira/Huly adapters can follow later, feeding the same shape). v1 scope,
// decided before this was built: always creates a brand-new board (no merge-into-existing
// mode — undo is just deleting the board), flat task list only (no parent/hierarchy column).
//
// One endpoint spanning three tables (tabs, board_members, tasks) in one transaction — that's
// why it's its own route file rather than living in tabs.ts (tab CRUD) or tasks.ts (task CRUD
// scoped to an EXISTING board's membership).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { recordAudit } from '../lib/audit.ts';
import { reconcileBoard } from '../realtime/ydoc.ts';
import { priority, statusEnum } from './tasks.ts';
import { rankAfter } from '../../shared/rank.ts';
import { MAX_TASK_DEPTH } from '../../shared/tree.ts';

const importRow = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  status: statusEnum,
  // Set only when the client determined the raw cell is email-shaped; resolved against real
  // users below. assigneeRaw is the original cell, kept for the `owner` free-text fallback.
  assigneeEmail: z.string().email().nullable().optional(),
  assigneeRaw: z.string().trim().max(200).nullable().optional(),
  priority: priority.nullable().optional(),
  date: z.string().nullable().optional(),
  // Sub-task nesting (SUBTASKS_PLAN P7). References another row's `id` WITHIN THIS IMPORT — the
  // client resolves the CSV's parent-by-title cell into an id. Anything not naming a row in the
  // same payload is dropped to null below, which also makes cross-board nesting unreachable here.
  parentId: z.string().nullable().optional(),
});

const importBody = z.object({
  boardId: z.string().min(1),
  projectId: z.string().min(1),
  boardName: z.string().trim().min(1).max(200),
  position: z.number().int().nonnegative(),
  rows: z.array(importRow).min(1).max(2000),
});

// Rate limit mirrors CREATE_BOARD_RL (tabs.ts) — an import also creates a board, plus up to
// 2000 task rows, so a slightly tighter cap bounds abuse from a scripted/malformed upload.
const IMPORT_RL = { max: 10, timeWindow: '1 minute' } as const;

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post(
    '/api/imports/csv',
    // No board-role check: the board doesn't exist yet, so there's nothing to be a member of.
    { config: { rateLimit: IMPORT_RL }, bodyLimit: 5 * 1024 * 1024 },
    async (req, reply) => {
      const b = importBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid import' });
      const userId = req.user!.id;
      const { boardId, projectId, boardName, position, rows } = b.data;

      // Resolve assignees by email in one query — exact, case-insensitive match only (mirrors
      // the board "add member by email" precedent in members.ts); no fuzzy name matching.
      const emails = [
        ...new Set(rows.map((r) => r.assigneeEmail?.toLowerCase()).filter((e): e is string => !!e)),
      ];
      const resolved = emails.length
        ? await db
            .select({ id: schema.users.id, email: schema.users.email })
            .from(schema.users)
            .where(inArray(schema.users.email, emails))
        : [];
      const byEmail = new Map(resolved.map((u) => [u.email, u.id]));
      const assigneeUserIds = [...new Set(byEmail.values())].filter((id) => id !== userId);

      await db.transaction(async (tx) => {
        // Same insert shape POST /api/tabs uses (tabs.ts) — inlined rather than an HTTP call so
        // a crash mid-import can't strand an orphaned empty board.
        await tx.insert(schema.tabs).values({ id: boardId, createdBy: userId, name: boardName, type: 'normal' });
        await tx.insert(schema.boardMembers).values({
          tabId: boardId, userId, role: 'admin', categoryId: projectId, position, starred: false,
        });
        // Grant editor access to every resolved assignee. A brand-new board has no members
        // besides its creator, so an imported assigneeId is only meaningful — visible in the
        // assignee picker, notifiable — if the import itself grants that membership.
        for (const aid of assigneeUserIds) {
          const posRows = await tx
            .select({ next: sql<number>`coalesce(max(${schema.boardMembers.position}), -1) + 1` })
            .from(schema.boardMembers)
            .where(eq(schema.boardMembers.userId, aid));
          await tx.insert(schema.boardMembers).values({
            tabId: boardId, userId: aid, role: 'editor', categoryId: null,
            position: Number(posRows[0]?.next ?? 0), starred: false,
          });
        }
        // Resolve the hierarchy before inserting. A parent must be another row in this same
        // payload; a cycle or an over-deep chain is flattened to a root rather than rejecting the
        // whole upload, because one malformed cell in a 2000-row export should not cost the user
        // the import. `parentOf` is the sanitized map everything below reads.
        const byId = new Map(rows.map((r) => [r.id, r]));
        const parentOf = new Map<string, string | null>();
        for (const r of rows) {
          let candidate = r.parentId && r.parentId !== r.id && byId.has(r.parentId) ? r.parentId : null;
          if (candidate) {
            // Walk up: reject if we come back to this row (cycle) or run past the depth limit.
            const seen = new Set<string>([r.id]);
            let cursor: string | null = candidate;
            let depth = 1;
            while (cursor) {
              if (seen.has(cursor) || depth > MAX_TASK_DEPTH) { candidate = null; break; }
              seen.add(cursor);
              cursor = byId.get(cursor)?.parentId ?? null;
              if (cursor && !byId.has(cursor)) cursor = null;
              depth++;
            }
          }
          parentOf.set(r.id, candidate);
        }

        // One rank sequence per sibling group, in file order — the order the user arranged.
        const rankOf = new Map<string, string>();
        const counters = new Map<string, string | null>();
        for (const r of rows) {
          const key = parentOf.get(r.id) ?? '';
          const next = rankAfter(counters.get(key) ?? null);
          counters.set(key, next);
          rankOf.set(r.id, next);
        }

        await tx.insert(schema.tasks).values(
          rows.map((r) => {
            const assigneeId = r.assigneeEmail ? byEmail.get(r.assigneeEmail.toLowerCase()) ?? null : null;
            return {
              id: r.id,
              homeTabId: boardId,
              text: r.title,
              status: r.status,
              assigneeId,
              date: r.date ?? null,
              priority: r.priority ?? null,
              parentTaskId: parentOf.get(r.id) ?? null,
              rank: rankOf.get(r.id) ?? null,
              owner: assigneeId ? null : r.assigneeRaw ?? null,
              done: r.status === 'done',
              createdBy: userId,
              lastTitle: r.title,
            };
          }),
        );
      });

      // The board's Yjs doc starts empty — reconcile appends id-only refs for every row just
      // inserted, which is what makes the tasks actually render when the board is opened. Do
      // not hand-roll docJSON edits, the CRDT layer would just overwrite them. Best-effort,
      // matching the task-restore endpoint's precedent (tasks.ts).
      try {
        await reconcileBoard(boardId);
      } catch (err) {
        req.log.error({ err, tabId: boardId }, 'csv import: board reconcile failed');
      }

      const matchedAssignees = rows.filter(
        (r) => r.assigneeEmail && byEmail.has(r.assigneeEmail.toLowerCase()),
      ).length;
      const unmatchedAssignees = rows.filter(
        (r) => r.assigneeEmail && !byEmail.has(r.assigneeEmail.toLowerCase()),
      ).length;

      req.auditHandled = true;
      recordAudit({
        actorId: userId, action: 'bulk_task_import', targetType: 'tab', targetId: boardId,
        scopeId: boardId, method: 'POST', status: 201,
        payload: { count: rows.length, source: 'csv', matchedAssignees },
      });

      return reply.code(201).send({ ok: true, tabId: boardId, created: rows.length, matchedAssignees, unmatchedAssignees });
    },
  );
}
