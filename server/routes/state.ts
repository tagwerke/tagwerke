import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gt } from 'drizzle-orm';
import { requireAuth } from '../auth/guard.ts';
import { patReaches } from '../auth/pat.ts';
import { assembleState, taskDTO } from '../lib/assembleState.ts';
import { db, schema } from '../db/client.ts';

/** How far behind the cursor the change feed re-reads. `updated_at` is stamped at statement time
 *  (the trigger uses now(), i.e. transaction start), but the row only becomes visible at COMMIT —
 *  so a write can land with a timestamp older than a cursor we already handed out. Re-reading a
 *  short window catches those; the client drops rows it already has (same `updatedAt`). */
const OVERLAP_MS = 5000;

/** Cap on one page of changes. Past this the client does a full /api/state pull instead. */
const CHANGES_LIMIT = 500;

export async function stateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/state', { preHandler: requireAuth, config: { pat: 'read' } }, async (req) => {
    // A token sees only the boards it reaches (the filter is a no-op for a cookie session).
    return assembleState(req.user!.id, (tabId) => patReaches(req, tabId));
  });

  // Task change feed — the safety net under the realtime socket (src/realtime/catchup.ts). A socket
  // that died quietly (sleep, a backgrounded PWA, a half-open connection) delivers nothing and
  // says nothing; a cheap poll of this keeps the open app current anyway.
  //
  // Returns every task on the caller's boards written after `since` (epoch ms), trashed ones as
  // `deleted` ids. `cursor` is the newest `updated_at` seen — DB clock only, so app/DB clock skew
  // never matters. Not covered (the full pull on focus/reconnect handles these): hard deletes,
  // tasks moved onto a board the caller isn't on, and board membership changes.
  app.get('/api/state/changes', { preHandler: requireAuth, config: { pat: 'read' } }, async (req, reply) => {
    const raw = Number((req.query as { since?: string }).since);
    if (!Number.isFinite(raw) || raw < 0) return reply.code(400).send({ error: 'since (epoch ms) is required' });
    const since = new Date(Math.max(0, raw - OVERLAP_MS));

    const rows = await db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .innerJoin(
        schema.boardMembers,
        and(eq(schema.boardMembers.tabId, schema.tasks.homeTabId), eq(schema.boardMembers.userId, req.user!.id)),
      )
      .where(gt(schema.tasks.updatedAt, since))
      .orderBy(asc(schema.tasks.updatedAt))
      .limit(CHANGES_LIMIT + 1);

    const more = rows.length > CHANGES_LIMIT;
    const page = (more ? rows.slice(0, CHANGES_LIMIT) : rows).map((r) => r.task).filter((t) => patReaches(req, t.homeTabId));

    const tasks: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    let cursor = raw;
    for (const t of page) {
      cursor = Math.max(cursor, t.updatedAt.getTime());
      if (t.deletedAt) deleted.push(t.id);
      else tasks.push(taskDTO(t));
    }
    return { tasks, deleted, cursor, more };
  });
}
