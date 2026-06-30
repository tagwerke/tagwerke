// Org (workspace) surface. The org IS the self-hosted instance — one singleton row,
// and every user is a member by virtue of having an account. No org_id scoping, no
// org_members table (it would be 1:1 with users). See AUTH_IMPLEMENTATION_PLAN.md Slice 1.
//
// `users.role` remains the org-admin axis (admin actions live under requireAdmin in
// admin.ts). This file is read-only member-facing identity + directory.

import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth, requireAdmin, requireSudo } from '../auth/guard.ts';
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
  app.get('/api/org/config', { preHandler: [requireAdmin, requireSudo] }, async () => {
    const rows = await db.select({ config: schema.org.config }).from(schema.org).limit(1);
    const cfg = (rows[0]?.config as Record<string, unknown> | null) ?? {};
    // Never return the OIDC client secret — mask it so the admin form shows "set" without
    // exposing the value. The PATCH below preserves it when the mask is sent back unchanged.
    const oidc = cfg.oidc as Record<string, unknown> | undefined;
    if (oidc && typeof oidc.clientSecret === 'string' && oidc.clientSecret) {
      cfg.oidc = { ...oidc, clientSecret: SECRET_MASK };
    }
    return { config: cfg };
  });

  // Shallow-merge a partial config patch (so one setting group can be updated in isolation).
  app.patch('/api/org/config', { preHandler: [requireAdmin, requireSudo] }, async (req, reply) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const rows = await db.select({ config: schema.org.config }).from(schema.org).limit(1);
    const current = (rows[0]?.config as Record<string, unknown> | null) ?? {};
    const next: Record<string, unknown> = { ...current, ...patch };

    // `oidc` is a nested group: deep-merge it, and preserve the stored clientSecret when the
    // incoming value is empty or the mask (the admin saved the form without re-typing it).
    if (patch.oidc && typeof patch.oidc === 'object') {
      const cur = (current.oidc as Record<string, unknown>) ?? {};
      const inc = patch.oidc as Record<string, unknown>;
      const merged = { ...cur, ...inc };
      if (inc.clientSecret === undefined || inc.clientSecret === '' || inc.clientSecret === SECRET_MASK) {
        merged.clientSecret = cur.clientSecret;
      }
      next.oidc = merged;
    }

    await db.update(schema.org).set({ config: next }).where(eq(schema.org.id, ORG_ID));
    req.auditHandled = true;
    recordAudit({ actorId: req.user!.id, action: 'org_config_update', targetType: 'org', targetId: ORG_ID, payload: { keys: Object.keys(patch) }, status: 200 });
    return reply.send({ ok: true });
  });
}

// Sentinel returned in place of a stored client secret; treated as "unchanged" on save.
const SECRET_MASK = '••••••••';
