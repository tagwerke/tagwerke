// Board activity: the "seen by / edited by + time" strip next to a board. Reads the
// compact board_activity presence table (one row per member). Any board member may read
// it; the seen-beacon is the member marking themselves present. See AUTH_IMPLEMENTATION_PLAN.md.

import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId } from '../auth/boards.ts';
import { touchSeen } from '../lib/boardActivity.ts';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Presence for a board: who has seen/edited it and when. Members only.
  app.get(
    '/api/tabs/:id/activity',
    { preHandler: requireBoardRole('viewer', paramTabId) },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await db
        .select({
          userId: schema.boardActivity.userId,
          email: schema.users.email,
          lastSeenAt: schema.boardActivity.lastSeenAt,
          lastEditedAt: schema.boardActivity.lastEditedAt,
        })
        .from(schema.boardActivity)
        .innerJoin(schema.users, eq(schema.users.id, schema.boardActivity.userId))
        .where(eq(schema.boardActivity.tabId, id))
        // Most-recently-active first (whichever of seen/edited is newer).
        .orderBy(desc(sql`greatest(
          coalesce(${schema.boardActivity.lastSeenAt}, 'epoch'),
          coalesce(${schema.boardActivity.lastEditedAt}, 'epoch')
        )`));
      return { activity: rows };
    },
  );

  // Beacon: the caller opened the board. Bumps their lastSeenAt. auditHandled = true so
  // the global audit hook skips it (no coarse row, and it must NOT count as an "edit").
  app.post(
    '/api/tabs/:id/seen',
    { preHandler: requireBoardRole('viewer', paramTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      req.auditHandled = true;
      touchSeen(id, req.user!.id);
      return reply.send({ ok: true });
    },
  );
}
