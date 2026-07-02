// Per-object history (Layer A of the accountability model): the user-facing "who changed
// what, when" timeline for a single task or board. A scoped projection of the append-only
// audit_log by (target_type, target_id) — NOT the admin-wide shape, so no cross-board leak.
//
// Role-restricted (AUDIT_IMPLEMENTATION_PLAN §C): editor+ on the item's board. The org-wide
// admin audit surface (routes/audit.ts) stays admin+sudo. Two surfaces, one store.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId } from '../auth/boards.ts';

/** Resolve the board that owns the task named in the route param. */
async function taskBoard(req: FastifyRequest): Promise<string | undefined> {
  const { id } = req.params as { id: string };
  const rows = await db.select({ homeTabId: schema.tasks.homeTabId }).from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return rows[0]?.homeTabId;
}

/** Newest-first audit rows for one target, joined to the actor's email. Bounded. */
async function historyFor(targetType: string, targetId: string) {
  const rows = await db
    .select({
      id: schema.auditLog.id,
      actorId: schema.auditLog.actorId,
      actorEmail: schema.users.email,
      action: schema.auditLog.action,
      payload: schema.auditLog.payload,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
    .where(and(eq(schema.auditLog.targetType, targetType), eq(schema.auditLog.targetId, targetId)))
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(100);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // A task's change timeline. Gated on editor+ of the task's home board.
  app.get('/api/tasks/:id/history', { preHandler: requireBoardRole('editor', taskBoard) }, async (req) => {
    const { id } = req.params as { id: string };
    return { entries: await historyFor('task', id) };
  });

  // A board's change timeline. Gated on editor+ of the board itself.
  app.get('/api/tabs/:id/history', { preHandler: requireBoardRole('editor', paramTabId) }, async (req) => {
    const { id } = req.params as { id: string };
    return { entries: await historyFor('tab', id) };
  });
}
