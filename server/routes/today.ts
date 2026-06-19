import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { renderTodayDocToText } from '../lib/render.ts';

const freezeBody = z.object({
  snapshotId: z.string().min(1),
  dateKey: z.string().min(1),
  docJSON: z.any(),
});

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function nextDay(dateKey: string): string {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function todayRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/today/freeze', async (req, reply) => {
    const b = freezeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const userId = req.user!.id;

    // The TODAY tab is the user's own board — resolve it via membership (not the
    // legacy tabs.user_id column, which Phase 6 cleanup will drop).
    const tabRows = await db
      .select({ id: schema.tabs.id })
      .from(schema.boardMembers)
      .innerJoin(schema.tabs, eq(schema.boardMembers.tabId, schema.tabs.id))
      .where(and(eq(schema.boardMembers.userId, userId), eq(schema.tabs.type, 'today')))
      .limit(1);
    const todayTab = tabRows[0];
    if (!todayTab) return reply.code(409).send({ error: 'no today tab' });

    const text = renderTodayDocToText(b.data.docJSON, b.data.dateKey);
    if (!text.trim()) return reply.send({ snapshot: null });

    const createdAt = Date.now();
    const nextDateKey = nextDay(b.data.dateKey);
    const snapshot = { id: b.data.snapshotId, dateKey: b.data.dateKey, createdAt, text };

    await db.transaction(async (tx) => {
      await tx.insert(schema.snapshots).values({ ...snapshot, userId });
      await tx
        .delete(schema.todayBlocks)
        .where(and(eq(schema.todayBlocks.userId, userId), eq(schema.todayBlocks.tabId, todayTab.id)));
      await tx
        .update(schema.tabs)
        .set({ docJSON: EMPTY_DOC, dateKey: nextDateKey })
        .where(eq(schema.tabs.id, todayTab.id));
    });

    return reply.send({ snapshot, nextDateKey, emptyDoc: EMPTY_DOC });
  });
}
