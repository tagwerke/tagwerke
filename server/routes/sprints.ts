// Sprints (SPRINTS_PLAN.md). Rows are created ONLY by server/lib/sprints.ts (board creation,
// weekly rollout) — there is no create route here, deliberately: the invariant "at most one
// current sprint per board" and the weekly cadence both live in one place. This file only lets
// a board member navigate what already exists: list, rename, switch which one is current,
// delete. Task assignment (`sprintId`) is a plain field on the existing task PATCH/PUT, not a
// route here — see server/routes/tasks.ts.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId, sprintTabId } from '../auth/boards.ts';
import { setCurrentSprint } from '../lib/sprints.ts';
import { auditEdit, diffChanges, recordAudit } from '../lib/audit.ts';

const patchBody = z.object({
  label: z.string().min(1).max(200).optional(),
  // true = make this the board's current sprint (atomic flip). false = just un-set this one,
  // leaving the board with no current sprint (SPRINTS_PLAN: "up to me to uncheck it").
  isCurrent: z.boolean().optional(),
});

export async function sprintRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/api/tabs/:id/sprints',
    { preHandler: requireBoardRole('viewer', paramTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await db
        .select()
        .from(schema.sprints)
        .where(eq(schema.sprints.tabId, id))
        .orderBy(desc(schema.sprints.startsAt));
      return reply.send({ sprints: rows });
    },
  );

  app.patch(
    '/api/sprints/:id',
    { preHandler: requireBoardRole('editor', sprintTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = patchBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
      const before = (await db.select().from(schema.sprints).where(eq(schema.sprints.id, id)).limit(1))[0];
      if (!before) return reply.code(404).send({ error: 'not found' });

      await db.transaction(async (tx) => {
        if (b.data.label !== undefined) {
          await tx.update(schema.sprints).set({ label: b.data.label }).where(eq(schema.sprints.id, id));
        }
        if (b.data.isCurrent === true) {
          await setCurrentSprint(tx, before.tabId, id);
        } else if (b.data.isCurrent === false) {
          await tx.update(schema.sprints).set({ isCurrent: false }).where(eq(schema.sprints.id, id));
        }
      });

      const changes = diffChanges(before as Record<string, unknown>, b.data as Record<string, unknown>, ['label', 'isCurrent']);
      auditEdit(req, { action: 'PATCH /api/sprints/:id', targetType: 'sprint', targetId: id, scopeId: before.tabId, changes });
      return reply.send({ ok: true });
    },
  );

  // Deleting a sprint returns its tasks to the backlog (tasks.sprint_id ON DELETE SET NULL) —
  // never a cascading delete of the tasks themselves.
  app.delete(
    '/api/sprints/:id',
    { preHandler: requireBoardRole('admin', sprintTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const before = (await db.select().from(schema.sprints).where(eq(schema.sprints.id, id)).limit(1))[0];
      if (!before) return reply.code(404).send({ error: 'not found' });
      await db.delete(schema.sprints).where(eq(schema.sprints.id, id));
      req.auditHandled = true;
      recordAudit({
        actorId: req.user!.id, action: 'DELETE /api/sprints/:id', targetType: 'sprint', targetId: id,
        scopeId: before.tabId, method: 'DELETE', status: 200, payload: { snapshot: { label: before.label } },
      });
      return reply.send({ ok: true });
    },
  );
}
