import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, notInArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, boardRole } from '../auth/boards.ts';

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
const statusEnum = z.enum(['todo', 'in_progress', 'in_review', 'done', 'cancelled']);

const upsertBody = z.object({
  homeTabId: z.string().min(1),
  text: z.string(),
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  priority: priority.nullable().optional(),
  position: z.number().int().optional(),
  owner: z.string().nullable().optional(),
  done: z.boolean().optional(),
});

const patchBody = z.object({
  text: z.string().optional(),
  status: statusEnum.optional(),
  assigneeId: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  priority: priority.nullable().optional(),
  position: z.number().int().optional(),
  owner: z.string().nullable().optional(),
  done: z.boolean().optional(),
});

const orphanBody = z.object({
  homeTabId: z.string().min(1),
  keepIds: z.array(z.string().min(1)),
});

// `done` is a derived back-compat mirror of status==='done' (see schema + SPEC §3).
// `owner` is the legacy free-text display fallback; `assigneeId` is the real assignment and,
// when set, is constrained to a member of the task's home board (SPEC §5).

/** True when `assigneeId` is null/undefined or names a member of `homeTabId`. */
async function assigneeAllowed(homeTabId: string, assigneeId: string | null | undefined): Promise<boolean> {
  if (assigneeId == null) return true;
  return (await boardRole(assigneeId, homeTabId)) != null;
}

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
      if (!(await assigneeAllowed(b.data.homeTabId, b.data.assigneeId)))
        return reply.code(400).send({ error: 'assignee is not a member of the home board' });
      const userId = req.user!.id;
      // status is authoritative; `done` is the derived back-compat mirror.
      const status = b.data.status ?? (b.data.done ? 'done' : 'todo');
      const values = {
        id,
        createdBy: userId,
        homeTabId: b.data.homeTabId,
        text: b.data.text,
        status,
        assigneeId: b.data.assigneeId ?? null,
        date: b.data.date ?? null,
        priority: b.data.priority ?? null,
        position: b.data.position ?? 0,
        owner: b.data.owner ?? null,
        done: status === 'done',
      };
      await db
        .insert(schema.tasks)
        .values(values)
        .onConflictDoUpdate({
          target: schema.tasks.id,
          set: {
            homeTabId: values.homeTabId,
            text: values.text,
            status: values.status,
            assigneeId: values.assigneeId,
            date: values.date,
            priority: values.priority,
            position: values.position,
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
      // Enforce assignee membership against the task's own home board.
      if (b.data.assigneeId != null) {
        const homeTabId = await taskBoard(req);
        if (!homeTabId) return reply.code(404).send({ error: 'not found' });
        if (!(await assigneeAllowed(homeTabId, b.data.assigneeId)))
          return reply.code(400).send({ error: 'assignee is not a member of the home board' });
      }
      // Keep the derived `done` mirror in sync whenever status is patched.
      const set = { ...b.data } as typeof b.data & { done?: boolean };
      if (b.data.status !== undefined) set.done = b.data.status === 'done';
      await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id));
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
