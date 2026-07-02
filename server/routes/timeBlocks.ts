// Planner facet: personal time blocks that reference a board (tab) and project its
// LIVE tasks — no per-block task list, no doc sync. A block is owned/written by its
// `user_id` but VISIBLE to every member of the referenced `tab_id`, which is what makes
// the day/week read double as "who's-on-what-today" across a shared board.
//
// Auth (reuses board_members via requireBoardRole/boardRole, per AUTH_ARCHITECTURE §3):
//   write  -> owner-only AND >= viewer on tab_id
//   read   -> own blocks + teammates' blocks on boards you're a member of

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, requireBoardRole } from '../auth/boards.ts';
import { reorderByIndex } from '../lib/reorder.ts';
import { auditEdit, diffChanges } from '../lib/audit.ts';

// Block fields worth a trail (skip position/filter — reorder noise / bulky projection).
const TB_AUDITED = ['tabId', 'date', 'start', 'end', 'label', 'assigneeId'] as const;

const DATE = z.string().min(8).max(10); // 'YYYY-MM-DD'

const createBody = z.object({
  id: z.string().min(1),
  tabId: z.string().min(1),
  date: DATE,
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  filter: z.any().optional(),
  assigneeId: z.string().nullable().optional(),
  position: z.number().int().nonnegative(),
});

const patchBody = z.object({
  tabId: z.string().min(1).optional(),
  date: DATE.optional(),
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  filter: z.any().optional(),
  assigneeId: z.string().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});

const reorderBody = z.object({ order: z.array(z.string().min(1)) });

export async function timeBlockRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Day/week read. One inner join over board_members yields BOTH the caller's own
  // blocks (they're a member of their own boards) and teammates' blocks on shared
  // boards, within [from, to]. roster resolves each owner id -> email.
  app.get('/api/time-blocks', async (req) => {
    const userId = req.user!.id;
    const q = req.query as { from?: string; to?: string };
    const from = q.from ?? new Date().toISOString().slice(0, 10);
    const to = q.to ?? from;

    const blocks = await db
      .select({
        id: schema.timeBlocks.id,
        userId: schema.timeBlocks.userId,
        tabId: schema.timeBlocks.tabId,
        date: schema.timeBlocks.date,
        start: schema.timeBlocks.start,
        end: schema.timeBlocks.end,
        label: schema.timeBlocks.label,
        filter: schema.timeBlocks.filter,
        assigneeId: schema.timeBlocks.assigneeId,
        position: schema.timeBlocks.position,
      })
      .from(schema.timeBlocks)
      .innerJoin(
        schema.boardMembers,
        and(
          eq(schema.boardMembers.tabId, schema.timeBlocks.tabId),
          eq(schema.boardMembers.userId, userId),
        ),
      )
      .where(and(gte(schema.timeBlocks.date, from), lte(schema.timeBlocks.date, to)))
      .orderBy(schema.timeBlocks.date, schema.timeBlocks.position);

    const ownerIds = [...new Set(blocks.map((b) => b.userId))];
    const roster = ownerIds.length
      ? await db
          .select({ userId: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, ownerIds))
      : [];
    return { blocks, roster };
  });

  // Create a block against a board the caller can at least view.
  app.post(
    '/api/time-blocks',
    { preHandler: requireBoardRole('viewer', (req) => (req.body as { tabId?: string })?.tabId) },
    async (req, reply) => {
      const b = createBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid block' });
      const userId = req.user!.id;
      await db.insert(schema.timeBlocks).values({
        id: b.data.id,
        userId,
        tabId: b.data.tabId,
        date: b.data.date,
        start: b.data.start ?? null,
        end: b.data.end ?? null,
        label: b.data.label ?? null,
        filter: b.data.filter ?? null,
        assigneeId: b.data.assigneeId ?? null,
        position: b.data.position,
      });
      return reply.code(201).send({ ok: true });
    },
  );

  app.patch('/api/time-blocks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;
    // Read the current block: ownership check + field diffs.
    const before = (await db.select().from(schema.timeBlocks).where(eq(schema.timeBlocks.id, id)).limit(1))[0];
    if (!before || before.userId !== userId) return reply.code(404).send({ error: 'not found' });
    // Rebinding to a new board requires at least viewer there.
    if (b.data.tabId !== undefined && !(await boardRole(userId, b.data.tabId)))
      return reply.code(404).send({ error: 'not found' });
    if (Object.keys(b.data).length === 0) return reply.send({ ok: true });
    await db
      .update(schema.timeBlocks)
      .set(b.data as Record<string, unknown>)
      .where(eq(schema.timeBlocks.id, id));
    const changes = diffChanges(before as Record<string, unknown>, b.data as Record<string, unknown>, TB_AUDITED);
    auditEdit(req, { action: 'PATCH /api/time-blocks/:id', targetType: 'time_block', targetId: id, scopeId: before.tabId, changes });
    return reply.send({ ok: true });
  });

  app.delete('/api/time-blocks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    await db
      .delete(schema.timeBlocks)
      .where(and(eq(schema.timeBlocks.id, id), eq(schema.timeBlocks.userId, userId)));
    return reply.send({ ok: true });
  });

  app.post('/api/time-blocks/reorder', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await reorderByIndex(b.data.order, (tx, id, position) =>
      tx
        .update(schema.timeBlocks)
        .set({ position })
        .where(and(eq(schema.timeBlocks.id, id), eq(schema.timeBlocks.userId, userId))));
    return reply.send({ ok: true });
  });
}
