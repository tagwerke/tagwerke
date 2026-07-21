// Board access-list management (the "Share" surface). All routes require auth; most
// require admin on the board. Self-leave is the one member-level action.
//
// A board's roster is members only — you add EXISTING platform users by email (no open
// invite here; account creation is the separate platform-invite flow).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, requireBoardRole, paramTabId } from '../auth/boards.ts';
import { recordAudit } from '../lib/audit.ts';
import { notify } from '../lib/notify.ts';
import { publish, userChannel } from '../lib/bus.ts';
import { applyBoardAccessChange } from '../realtime/connections.ts';

const roleEnum = z.enum(['viewer', 'editor', 'admin']);

// Tell an affected user their board access changed, over their personal feed (the channel each
// client subscribes to on connect). They aren't on the board's channel when added/removed, so
// this is the only way to reach them. The client re-pulls state → the sidebar updates live.
function notifyBoardList(targetUserId: string, tabId: string, action: 'added' | 'removed' | 'role'): void {
  publish(userChannel(targetUserId), { v: 1, type: 'board-list', action, tabId });
}
const addBody = z.object({ email: z.string().email().max(320), role: roleEnum.default('viewer') });
const patchBody = z.object({ role: roleEnum });

// Rate limits (IP-keyed, like the auth routes — see server/auth/routes.ts). The abuse surfaces here
// are membership churn (mass invites / role-flips) and email/account enumeration via the user search
// plus the add-member existence oracle (404 no-user vs 409 already-member). Limits are generous
// enough that no legitimate admin hits them.
const MEMBER_WRITE_RL = { max: 60, timeWindow: '1 minute' } as const;
const LOOKUP_RL = { max: 30, timeWindow: '1 minute' } as const;

async function adminCount(tabId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.tabId, tabId), eq(schema.boardMembers.role, 'admin')));
  return Number(rows[0]?.c ?? 0);
}

/** True when the caller is an admin on at least one board — i.e. can manage members somewhere,
 *  which is what authorizes the user lookup. Board-level, NOT the platform admin role. */
async function canManageAnyBoard(userId: string): Promise<boolean> {
  const rows = await db
    .select({ tabId: schema.boardMembers.tabId })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.userId, userId), eq(schema.boardMembers.role, 'admin')))
    .limit(1);
  return rows.length > 0;
}

/** Escape a user string so it matches LITERALLY inside a LIKE/ILIKE pattern. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Workspace user lookup for the "add member" picker. A SEARCH, not a directory dump: needs a
  // ≥2-char query and returns at most a handful of minimal rows (id + email only — no roles, no
  // platform-admin data). Authorized for anyone who can manage members on some board, so board
  // admins can add any teammate without already sharing a board with them. Enumeration is bounded
  // by the query requirement; org-wide privacy, if ever needed, belongs behind an org setting.
  app.get('/api/users/lookup', { config: { rateLimit: LOOKUP_RL } }, async (req, reply) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return { users: [] }; // below the search threshold → nothing (no bulk list)
    if (!(await canManageAnyBoard(req.user!.id)))
      return reply.code(403).send({ error: 'insufficient permission' });
    const pattern = `%${escapeLike(q.toLowerCase())}%`;
    const rows = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(and(ilike(schema.users.email, pattern), isNull(schema.users.deactivatedAt)))
      .orderBy(asc(schema.users.email))
      .limit(10);
    return { users: rows };
  });

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
    { preHandler: requireBoardRole('admin', paramTabId), config: { rateLimit: MEMBER_WRITE_RL } },
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
      notifyBoardList(targetId, id, 'added'); // the new member's sidebar picks it up live
      // Notify the added user (feed + push). Board name as the body; skip self-adds.
      if (targetId !== req.user!.id) {
        const tab = (await db.select({ name: schema.tabs.name }).from(schema.tabs).where(eq(schema.tabs.id, id)).limit(1))[0];
        notify(targetId, { type: 'board_added', title: 'Added to a board', body: tab?.name ?? 'A board', tabId: id, actorId: req.user!.id });
      }
      return reply.code(201).send({ ok: true, userId: targetId });
    },
  );

  // Change a member's role. Admin only. Cannot demote the last admin.
  app.patch(
    '/api/tabs/:id/members/:userId',
    { preHandler: requireBoardRole('admin', paramTabId), config: { rateLimit: MEMBER_WRITE_RL } },
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

      notifyBoardList(userId, id, 'role'); // their permissions changed → re-pull to reflect it
      // Re-tier any live socket this user has open on the board, so a demotion drops write access
      // (and a promotion grants it) immediately — not only after they reconnect.
      await applyBoardAccessChange(userId, id, b.data.role);
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
  app.delete('/api/tabs/:id/members/:userId', { config: { rateLimit: MEMBER_WRITE_RL } }, async (req, reply) => {
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

    notifyBoardList(userId, id, 'removed'); // the removed user's board disappears live
    // Evict any live socket this user has on the board: leave its doc room and unsubscribe it from
    // the board's entity channel, so a non-cooperative client can no longer read or write it over
    // an already-open connection (the notify above only asks a cooperative client to drop it).
    await applyBoardAccessChange(userId, id, null);

    // Explicit audit (was a blind spot): access revocation must be visible. Distinguishes
    // self-leave from an admin removing someone.
    req.auditHandled = true;
    recordAudit({
      actorId: me,
      action: userId === me ? 'board_leave' : 'board_member_remove',
      targetType: 'board_member',
      targetId: userId,
      scopeId: id,
      method: 'DELETE',
      status: 200,
      payload: { tabId: id, removed: userId, role: targetRows[0].role },
    });
    return reply.send({ ok: true });
  });
}
