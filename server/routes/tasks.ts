import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';

const priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const upsertBody = z.object({
  homeTabId: z.string().min(1),
  text: z.string(),
  date: z.string().nullable().optional(),
  priority: priority.nullable().optional(),
  owner: z.string().nullable().optional(),
  done: z.boolean().optional(),
});

const patchBody = z.object({
  text: z.string().optional(),
  date: z.string().nullable().optional(),
  priority: priority.nullable().optional(),
  owner: z.string().nullable().optional(),
  done: z.boolean().optional(),
});

const orphanBody = z.object({
  homeTabId: z.string().min(1),
  keepIds: z.array(z.string().min(1)),
});

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.put('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = upsertBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid task' });
    const userId = req.user!.id;
    const values = {
      id,
      userId,
      homeTabId: b.data.homeTabId,
      text: b.data.text,
      date: b.data.date ?? null,
      priority: b.data.priority ?? null,
      owner: b.data.owner ?? null,
      done: b.data.done ?? false,
    };
    await db
      .insert(schema.tasks)
      .values(values)
      .onConflictDoUpdate({
        target: schema.tasks.id,
        set: {
          homeTabId: values.homeTabId,
          text: values.text,
          date: values.date,
          priority: values.priority,
          owner: values.owner,
          done: values.done,
        },
      });
    return reply.send({ ok: true });
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;
    await db
      .update(schema.tasks)
      .set(b.data)
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)));
    return reply.send({ ok: true });
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    await db.delete(schema.tasks).where(and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)));
    return reply.send({ ok: true });
  });

  app.post('/api/tasks/delete-orphans', async (req, reply) => {
    const b = orphanBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const userId = req.user!.id;
    const conds = [eq(schema.tasks.userId, userId), eq(schema.tasks.homeTabId, b.data.homeTabId)];
    if (b.data.keepIds.length) conds.push(notInArray(schema.tasks.id, b.data.keepIds));
    await db.delete(schema.tasks).where(and(...conds));
    return reply.send({ ok: true });
  });
}
