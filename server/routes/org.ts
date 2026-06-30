// Org (workspace) surface. The org IS the self-hosted instance — one singleton row,
// and every user is a member by virtue of having an account. No org_id scoping, no
// org_members table (it would be 1:1 with users). See AUTH_IMPLEMENTATION_PLAN.md Slice 1.
//
// `users.role` remains the org-admin axis (admin actions live under requireAdmin in
// admin.ts). This file is read-only member-facing identity + directory.

import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth, requireAdmin } from '../auth/guard.ts';
import { recordAudit } from '../lib/audit.ts';

// Fixed primary key for the singleton org row (seeded on boot in index.ts).
export const ORG_ID = 'org';

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // The workspace identity. Any member may read it.
  app.get('/api/org', async () => {
    const rows = await db.select({ name: schema.org.name }).from(schema.org).limit(1);
    return { name: rows[0]?.name ?? 'Workspace' };
  });

  // The member directory: every user, trimmed to { id, email }. Role + createdAt stay
  // on the admin-only /api/admin/users — members see WHO their colleagues are, not the
  // org-admin metadata. Full roster fits a corporate tool; trimmed fields keep it
  // data-minimal (GDPR Art. 5).
  app.get('/api/org/members', async () => {
    const members = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .orderBy(asc(schema.users.email));
    return { members };
  });

  // ── Org config — the reserved surface for enterprise settings ─────────────
  // SSO/SAML (Slice 6) and SCIM (Slice 7) will read/write their IdP + provisioning
  // config here. The storage surface is in place now; the protocol handlers are
  // DEFERRED pending an IdP choice (Google Workspace / Okta / Entra) — see
  // AUTH_IMPLEMENTATION_PLAN.md §Slice 6–7. Admin-only.
  app.get('/api/org/config', { preHandler: requireAdmin }, async () => {
    const rows = await db.select({ config: schema.org.config }).from(schema.org).limit(1);
    return { config: (rows[0]?.config as Record<string, unknown> | null) ?? {} };
  });

  // Shallow-merge a partial config patch (so one setting group can be updated in isolation).
  app.patch('/api/org/config', { preHandler: requireAdmin }, async (req, reply) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const rows = await db.select({ config: schema.org.config }).from(schema.org).limit(1);
    const current = (rows[0]?.config as Record<string, unknown> | null) ?? {};
    await db.update(schema.org).set({ config: { ...current, ...patch } }).where(eq(schema.org.id, ORG_ID));
    req.auditHandled = true;
    recordAudit({ actorId: req.user!.id, action: 'org_config_update', targetType: 'org', targetId: ORG_ID, payload: { keys: Object.keys(patch) }, status: 200 });
    return reply.send({ ok: true });
  });
}
