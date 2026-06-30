// Org (workspace) surface. The org IS the self-hosted instance — one singleton row,
// and every user is a member by virtue of having an account. No org_id scoping, no
// org_members table (it would be 1:1 with users). See AUTH_IMPLEMENTATION_PLAN.md Slice 1.
//
// `users.role` remains the org-admin axis (admin actions live under requireAdmin in
// admin.ts). This file is read-only member-facing identity + directory.

import type { FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';

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
}
