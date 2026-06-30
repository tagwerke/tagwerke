// Board access-list management (the "Share" surface). All routes require auth; most
// require admin on the board. Self-leave is the one member-level action.
//
// A board's roster is members only — you add EXISTING platform users by email (no open
// invite here; account creation is the separate platform-invite flow).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, requireBoardRole, paramTabId } from '../auth/boards.ts';
import { recordAudit } from '../lib/audit.ts';

const roleEnum = z.enum(['viewer', 'editor', 'admin']);
const addBody = z.object({ email: z.string().email().max(320), role: roleEnum.default('viewer') });
const patchBody = z.object({ role: roleEnum });

async function adminCount(tabId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.tabId, tabId), eq(schema.boardMembers.role, 'admin')));
  return Number(rows[0]?.c ?? 0);
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List the access list. Any member may see who else is on the board.
  app.get(
    '/api/tabs/:id/members',
    { preHandler: requireBoardRole('viewer', paramTabId) },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await db
        .select({
          userId: schema.boardMembers.userId,
          email: schema.users.email,
          role: schema.boardMembers.role,
        })
        .from(schema.boardMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.boardMembers.userId))
        .where(eq(schema.boardMembers.tabId, id));
      return { members: rows };
    },
  );

  // Add an existing user to the board. Admin only.
  app.post(
    '/api/tabs/:id/members',
    { preHandler: requireBoardRole('admin', paramTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = addBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid request' });
      const email = b.data.email.toLowerCase();

      const users = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (!users.length) return reply.code(404).send({ error: 'no user with that email' });
      const targetId = users[0].id;

      const existing = await db
        .select({ userId: schema.boardMembers.userId })
        .from(schema.boardMembers)
        .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, targetId)))
        .limit(1);
      if (existing.length) return reply.code(409).send({ error: 'already a member' });

      // Place the board at the end of the new member's personal order; no category yet.
      const posRows = await db
        .select({ next: sql<number>`coalesce(max(${schema.boardMembers.position}), -1) + 1` })
        .from(schema.boardMembers)
        .where(eq(schema.boardMembers.userId, targetId));
      const position = Number(posRows[0]?.next ?? 0);

      await db.insert(schema.boardMembers).values({
        tabId: id,
        userId: targetId,
        role: b.data.role,
        position,
        starred: false,
      });
      return reply.code(201).send({ ok: true, userId: targetId });
    },
  );

  // Change a member's role. Admin only. Cannot demote the last admin.
  app.patch(
    '/api/tabs/:id/members/:userId',
    { preHandler: requireBoardRole('admin', paramTabId) },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const b = patchBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid request' });

      // Prior role: reused by the last-admin guard and the audit row below.
      const beforeRows = await db
        .select({ role: schema.boardMembers.role })
        .from(schema.boardMembers)
        .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, userId)))
        .limit(1);
      const fromRole = beforeRows[0]?.role ?? null;

      if (b.data.role !== 'admin' && fromRole === 'admin' && (await adminCount(id)) <= 1) {
        return reply.code(409).send({ error: 'cannot demote the last admin' });
      }

      await db
        .update(schema.boardMembers)
        .set({ role: b.data.role })
        .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, userId)));

      req.auditHandled = true;
      recordAudit({
        actorId: req.user!.id,
        action: 'board_role_change',
        targetType: 'board_member',
        targetId: userId,
        payload: { tabId: id, from: fromRole, to: b.data.role },
        status: 200,
      });
      return reply.send({ ok: true });
    },
  );

  // Remove a member. Removing someone else requires admin; removing YOURSELF (leave the
  // board) is allowed for any member. Either way, the last admin cannot be removed.
  app.delete('/api/tabs/:id/members/:userId', async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const me = req.user!.id;

    const myRole = await boardRole(me, id);
    if (userId === me) {
      // Self-leave: just need to be a member.
      if (!myRole) return reply.code(404).send({ error: 'not found' });
    } else {
      // Acting on another member requires admin on the board.
      if (myRole !== 'admin') return reply.code(403).send({ error: 'insufficient permission' });
    }

    const targetRows = await db
      .select({ role: schema.boardMembers.role })
      .from(schema.boardMembers)
      .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, userId)))
      .limit(1);
    if (!targetRows.length) return reply.send({ ok: true });
    if (targetRows[0].role === 'admin' && (await adminCount(id)) <= 1)
      return reply.code(409).send({ error: 'cannot remove the last admin; delete the board or promote someone first' });

    await db
      .delete(schema.boardMembers)
      .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, userId)));
    return reply.send({ ok: true });
  });
}
