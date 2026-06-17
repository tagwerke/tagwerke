import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';

const createBody = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  starred: z.boolean().optional(),
  type: z.enum(['normal', 'today']).optional(),
});

const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).optional(),
  starred: z.boolean().optional(),
  starredPosition: z.number().int().nonnegative().nullable().optional(),
  dateKey: z.string().nullable().optional(),
  docJSON: z.any().optional(),
});

const reorderBody = z.object({ order: z.array(z.string().min(1)) });

export async function tabRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/tabs', async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid tab' });
    const userId = req.user!.id;
    await db.insert(schema.tabs).values({
      id: b.data.id,
      userId,
      projectId: b.data.projectId,
      name: b.data.name,
      position: b.data.position,
      starred: b.data.starred ?? false,
      type: b.data.type ?? 'normal',
    });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/tabs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;
    await db
      .update(schema.tabs)
      .set(b.data)
      .where(and(eq(schema.tabs.id, id), eq(schema.tabs.userId, userId)));
    return reply.send({ ok: true });
  });

  app.post('/api/tabs/reorder', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < b.data.order.length; i++) {
        await tx
          .update(schema.tabs)
          .set({ position: i })
          .where(and(eq(schema.tabs.id, b.data.order[i]), eq(schema.tabs.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  app.post('/api/tabs/reorder-starred', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < b.data.order.length; i++) {
        await tx
          .update(schema.tabs)
          .set({ starredPosition: i })
          .where(and(eq(schema.tabs.id, b.data.order[i]), eq(schema.tabs.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  app.delete('/api/tabs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const rows = await db
      .select({ type: schema.tabs.type })
      .from(schema.tabs)
      .where(and(eq(schema.tabs.id, id), eq(schema.tabs.userId, userId)))
      .limit(1);
    if (!rows.length) return reply.send({ ok: true });
    if (rows[0].type === 'today') return reply.code(409).send({ error: 'cannot delete the today tab' });

    await db.transaction(async (tx) => {
      // Remove TODAY blocks whose source tab is this tab (they belong to the today
      // tab, so they won't be removed by the cascade on this tab's deletion).
      await tx
        .delete(schema.todayBlocks)
        .where(and(eq(schema.todayBlocks.userId, userId), eq(schema.todayBlocks.homeTabId, id)));
      // Deleting the tab cascades its tasks (home_tab_id) and any blocks owned by it.
      await tx.delete(schema.tabs).where(and(eq(schema.tabs.id, id), eq(schema.tabs.userId, userId)));
    });
    return reply.send({ ok: true });
  });
}
