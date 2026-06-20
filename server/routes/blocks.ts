import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, requireBoardRole } from '../auth/boards.ts';
import { reorderByIndex } from '../lib/reorder.ts';

/** Resolve the home board of the task named in the request body (by taskId). */
async function bodyTaskBoard(req: FastifyRequest): Promise<string | undefined> {
  const taskId = (req.body as { taskId?: string })?.taskId;
  if (!taskId) return undefined;
  const rows = await db
    .select({ homeTabId: schema.tasks.homeTabId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return rows[0]?.homeTabId;
}

const createBody = z.object({
  id: z.string().min(1),
  homeTabId: z.string().min(1),
  position: z.number().int().nonnegative(),
});

const patchBody = z.object({
  homeTabId: z.string().min(1).optional(), // TodayBlock.tabId (source tab)
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
});

const addTaskBody = z.object({ taskId: z.string().min(1) });
const reorderBody = z.object({ order: z.array(z.string().min(1)) });

async function todayTabId(userId: string): Promise<string | null> {
  // The user's TODAY board, resolved via membership.
  const rows = await db
    .select({ id: schema.tabs.id })
    .from(schema.boardMembers)
    .innerJoin(schema.tabs, eq(schema.boardMembers.tabId, schema.tabs.id))
    .where(and(eq(schema.boardMembers.userId, userId), eq(schema.tabs.type, 'today')))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function blockRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Binding a block to a source board requires READ on that board.
  app.post(
    '/api/blocks',
    { preHandler: requireBoardRole('viewer', (req) => (req.body as { homeTabId?: string })?.homeTabId) },
    async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid block' });
    const userId = req.user!.id;
    const tabId = await todayTabId(userId);
    if (!tabId) return reply.code(409).send({ error: 'no today tab' });

    await db.transaction(async (tx) => {
      // Make room: shift blocks at/after the insert position down by one.
      await tx
        .update(schema.todayBlocks)
        .set({ position: sql`${schema.todayBlocks.position} + 1` })
        .where(
          and(
            eq(schema.todayBlocks.userId, userId),
            eq(schema.todayBlocks.tabId, tabId),
            gte(schema.todayBlocks.position, b.data.position),
          ),
        );
      await tx.insert(schema.todayBlocks).values({
        id: b.data.id,
        userId,
        tabId,
        homeTabId: b.data.homeTabId,
        position: b.data.position,
      });
    });
    return reply.code(201).send({ ok: true });
    },
  );

  app.patch('/api/blocks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;
    const { homeTabId, ...rest } = b.data;
    // Rebinding a block to a new source board requires READ on that board.
    if (homeTabId !== undefined && !(await boardRole(userId, homeTabId)))
      return reply.code(404).send({ error: 'not found' });
    const set: Record<string, unknown> = { ...rest };
    if (homeTabId !== undefined) set.homeTabId = homeTabId;
    await db
      .update(schema.todayBlocks)
      .set(set)
      .where(and(eq(schema.todayBlocks.id, id), eq(schema.todayBlocks.userId, userId)));
    return reply.send({ ok: true });
  });

  app.delete('/api/blocks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    await db
      .delete(schema.todayBlocks)
      .where(and(eq(schema.todayBlocks.id, id), eq(schema.todayBlocks.userId, userId)));
    return reply.send({ ok: true });
  });

  app.post(
    '/api/blocks/:id/tasks',
    { preHandler: requireBoardRole('viewer', bodyTaskBoard) },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = addTaskBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const userId = req.user!.id;
    // Ownership: ensure the block belongs to the user.
    const owns = await db
      .select({ id: schema.todayBlocks.id })
      .from(schema.todayBlocks)
      .where(and(eq(schema.todayBlocks.id, id), eq(schema.todayBlocks.userId, userId)))
      .limit(1);
    if (!owns.length) return reply.code(404).send({ error: 'block not found' });

    const countRows = await db
      .select({ c: sql<number>`count(*)` })
      .from(schema.todayBlockTasks)
      .where(eq(schema.todayBlockTasks.blockId, id));
    const position = Number(countRows[0]?.c ?? 0);

    await db
      .insert(schema.todayBlockTasks)
      .values({ blockId: id, taskId: b.data.taskId, position })
      .onConflictDoNothing();
    return reply.send({ ok: true });
    },
  );

  app.delete('/api/blocks/:id/tasks/:taskId', async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const userId = req.user!.id;
    const owns = await db
      .select({ id: schema.todayBlocks.id })
      .from(schema.todayBlocks)
      .where(and(eq(schema.todayBlocks.id, id), eq(schema.todayBlocks.userId, userId)))
      .limit(1);
    if (!owns.length) return reply.code(404).send({ error: 'block not found' });
    await db
      .delete(schema.todayBlockTasks)
      .where(and(eq(schema.todayBlockTasks.blockId, id), eq(schema.todayBlockTasks.taskId, taskId)));
    return reply.send({ ok: true });
  });

  app.post('/api/blocks/reorder', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await reorderByIndex(b.data.order, (tx, id, position) =>
      tx
        .update(schema.todayBlocks)
        .set({ position })
        .where(and(eq(schema.todayBlocks.id, id), eq(schema.todayBlocks.userId, userId))));
    return reply.send({ ok: true });
  });
}
