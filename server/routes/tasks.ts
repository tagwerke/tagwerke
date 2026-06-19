import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole } from '../auth/boards.ts';

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

// NOTE: `owner` is intentionally NOT constrained to a board member. The member picker
// (typing "[") sets a real user id, but legacy free-text owners ("Kirill"/"Chuck")
// remain valid — owner is filterable, not load-bearing (SPEC §3).

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
      const userId = req.user!.id;
      const values = {
        id,
        userId,
        createdBy: userId,
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
    },
  );

  app.patch(
    '/api/tasks/:id',
    { preHandler: requireBoardRole('editor', taskBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = patchBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
      await db.update(schema.tasks).set(b.data).where(eq(schema.tasks.id, id));
      return reply.send({ ok: true });
    },
  );

  app.delete(
    '/api/tasks/:id',
    { preHandler: requireBoardRole('editor', taskBoard) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/api/tasks/delete-orphans',
    { preHandler: requireBoardRole('editor', (req) => (req.body as { homeTabId?: string })?.homeTabId) },
    async (req, reply) => {
      const b = orphanBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid request' });
      const conds = [eq(schema.tasks.homeTabId, b.data.homeTabId)];
      if (b.data.keepIds.length) conds.push(notInArray(schema.tasks.id, b.data.keepIds));
      await db.delete(schema.tasks).where(and(...conds));
      return reply.send({ ok: true });
    },
  );
}
