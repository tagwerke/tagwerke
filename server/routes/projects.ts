import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';

const createBody = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  color: z.string().min(1).max(32),
  position: z.number().int().nonnegative(),
});

const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  color: z.string().min(1).max(32).optional(),
});

const reorderBody = z.object({ order: z.array(z.string().min(1)) });

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/projects', async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid project' });
    const userId = req.user!.id;
    await db.insert(schema.projects).values({ ...b.data, userId });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;
    await db
      .update(schema.projects)
      .set(b.data)
      .where(and(eq(schema.projects.id, id), eq(schema.projects.userId, userId)));
    return reply.send({ ok: true });
  });

  app.post('/api/projects/reorder', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < b.data.order.length; i++) {
        await tx
          .update(schema.projects)
          .set({ position: i })
          .where(and(eq(schema.projects.id, b.data.order[i]), eq(schema.projects.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      const projectRows = await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.userId, userId))
        .orderBy(asc(schema.projects.position));
      if (projectRows.length <= 1) return; // refuse to delete the last project
      const fallback = projectRows.find((p) => p.id !== id);
      if (!fallback) return;

      // Reassign any TODAY tab in this project to the fallback so cascade-delete
      // does not remove it; normal tabs (+ their tasks) cascade away with the project.
      await tx
        .update(schema.tabs)
        .set({ projectId: fallback.id })
        .where(
          and(
            eq(schema.tabs.userId, userId),
            eq(schema.tabs.projectId, id),
            eq(schema.tabs.type, 'today'),
          ),
        );

      await tx
        .delete(schema.projects)
        .where(and(eq(schema.projects.id, id), eq(schema.projects.userId, userId), ne(schema.projects.id, fallback.id)));
    });
    return reply.send({ ok: true });
  });
}
