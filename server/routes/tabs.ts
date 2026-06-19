import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, requireBoardRole } from '../auth/boards.ts';

const createBody = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  starred: z.boolean().optional(),
  type: z.enum(['normal', 'today']).optional(),
});

const patchBody = z.object({
  // Content (lives on the shared tab):
  name: z.string().min(1).max(200).optional(),
  dateKey: z.string().nullable().optional(),
  docJSON: z.any().optional(),
  location: z.string().nullable().optional(),
  // Per-user view state (lives on this caller's board_members row):
  projectId: z.string().min(1).optional(), // = the caller's category
  starred: z.boolean().optional(),
  starredPosition: z.number().int().nonnegative().nullable().optional(),
});

const reorderBody = z.object({ order: z.array(z.string().min(1)) });

export async function tabRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/api/tabs', async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid tab' });
    const userId = req.user!.id;
    const starred = b.data.starred ?? false;
    await db.transaction(async (tx) => {
      // Shared content. Legacy user_id/project_id/position/starred stay populated
      // through the additive transition (dropped in Phase 6); created_by is the new
      // attribution column.
      await tx.insert(schema.tabs).values({
        id: b.data.id,
        userId,
        createdBy: userId,
        projectId: b.data.projectId,
        name: b.data.name,
        position: b.data.position,
        starred,
        type: b.data.type ?? 'normal',
      });
      // The creator's membership = admin. Carries this user's view state.
      await tx.insert(schema.boardMembers).values({
        tabId: b.data.id,
        userId,
        role: 'admin',
        categoryId: b.data.projectId,
        position: b.data.position,
        starred,
      });
    });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/tabs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;

    // Split: content updates the shared tab; view state updates the caller's membership.
    const { projectId, starred, starredPosition, ...content } = b.data;

    // Authorize: must be a member; editing shared content requires editor+.
    const role = await boardRole(userId, id);
    if (!role) return reply.code(404).send({ error: 'not found' });
    if (Object.keys(content).length && role === 'viewer')
      return reply.code(403).send({ error: 'insufficient permission' });

    const memberPatch: Record<string, unknown> = {};
    if (projectId !== undefined) memberPatch.categoryId = projectId;
    if (starred !== undefined) memberPatch.starred = starred;
    if (starredPosition !== undefined) memberPatch.starredPosition = starredPosition;

    await db.transaction(async (tx) => {
      if (Object.keys(content).length) {
        await tx.update(schema.tabs).set(content).where(eq(schema.tabs.id, id));
      }
      if (Object.keys(memberPatch).length) {
        await tx
          .update(schema.boardMembers)
          .set(memberPatch)
          .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  app.post('/api/tabs/reorder', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < b.data.order.length; i++) {
        await tx
          .update(schema.boardMembers)
          .set({ position: i })
          .where(and(eq(schema.boardMembers.tabId, b.data.order[i]), eq(schema.boardMembers.userId, userId)));
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
          .update(schema.boardMembers)
          .set({ starredPosition: i })
          .where(and(eq(schema.boardMembers.tabId, b.data.order[i]), eq(schema.boardMembers.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  // Deleting a board removes it for EVERYONE (admin action). To drop only your own
  // access, leave the board via DELETE /api/tabs/:id/members/:me (members route).
  app.delete(
    '/api/tabs/:id',
    { preHandler: requireBoardRole('admin', (req) => (req.params as { id: string }).id) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rows = await db.select({ type: schema.tabs.type }).from(schema.tabs).where(eq(schema.tabs.id, id)).limit(1);
      if (!rows.length) return reply.send({ ok: true });
      if (rows[0].type === 'today') return reply.code(409).send({ error: 'cannot delete the today tab' });

      await db.transaction(async (tx) => {
        // TODAY blocks reference this board by home_tab_id (no FK), across ALL users —
        // remove them so no one is left with dangling references to a deleted board.
        await tx.delete(schema.todayBlocks).where(eq(schema.todayBlocks.homeTabId, id));
        // Deleting the tab cascades its tasks, memberships, events, and owned blocks.
        await tx.delete(schema.tabs).where(eq(schema.tabs.id, id));
      });
      return reply.send({ ok: true });
    },
  );
}
