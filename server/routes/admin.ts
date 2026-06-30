// Platform-admin API: list users, manage signup invites. Gated on users.role='admin'
// via requireAdmin. The extra network/identity layer for admins (Tailscale-style) is
// infra — intentionally NOT modeled here (SPEC §9.8).
//
// This is the in-app counterpart to the `npm run invite` CLI (which remains as a
// break-glass path).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { requireAdmin } from '../auth/guard.ts';
import { recordAudit } from '../lib/audit.ts';
import { deleteUserSessions } from '../auth/session.ts';

const inviteBody = z.object({
  maxUses: z.number().int().min(1).max(1000).default(1),
  days: z.number().int().min(1).max(3650).nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/users', async () => {
    const users = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        createdAt: schema.users.createdAt,
        deactivatedAt: schema.users.deactivatedAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt));
    return { users };
  });

  // Deactivate / reactivate a user (suspend without deleting; the hook SCIM deprovisioning
  // uses). Deactivating also drops their sessions. Can't deactivate yourself.
  app.patch('/api/admin/users/:id/active', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    if (id === req.user!.id && !b.data.active)
      return reply.code(409).send({ error: 'cannot deactivate yourself' });

    await db
      .update(schema.users)
      .set({ deactivatedAt: b.data.active ? null : new Date() })
      .where(eq(schema.users.id, id));
    if (!b.data.active) await deleteUserSessions(id);

    req.auditHandled = true;
    recordAudit({
      actorId: req.user!.id,
      action: b.data.active ? 'user_reactivated' : 'user_deactivated',
      targetType: 'user',
      targetId: id,
      status: 200,
    });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/invites', async () => {
    const invites = await db.select().from(schema.invites).orderBy(desc(schema.invites.createdAt));
    return { invites };
  });

  app.post('/api/admin/invites', async (req, reply) => {
    const b = inviteBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid invite' });
    const code = nanoid(12);
    const expiresAt = b.data.days != null ? new Date(Date.now() + b.data.days * 86400000) : null;
    await db.insert(schema.invites).values({
      code,
      maxUses: b.data.maxUses,
      expiresAt,
      note: b.data.note ?? null,
    });
    return reply.code(201).send({ code, maxUses: b.data.maxUses, expiresAt, note: b.data.note ?? null });
  });

  app.delete('/api/admin/invites/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    await db.delete(schema.invites).where(eq(schema.invites.code, code));
    return reply.send({ ok: true });
  });

  // Promote/demote a user. Cannot demote yourself (avoid locking the platform out of
  // its last admin by accident).
  app.patch('/api/admin/users/:id/role', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ role: z.enum(['admin', 'member']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid role' });
    if (id === req.user!.id && b.data.role !== 'admin')
      return reply.code(409).send({ error: 'cannot demote yourself' });

    const beforeRows = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
    await db.update(schema.users).set({ role: b.data.role }).where(eq(schema.users.id, id));

    req.auditHandled = true;
    recordAudit({
      actorId: req.user!.id,
      action: 'platform_role_change',
      targetType: 'user',
      targetId: id,
      payload: { from: beforeRows[0]?.role ?? null, to: b.data.role },
      status: 200,
    });
    return reply.send({ ok: true });
  });
}
