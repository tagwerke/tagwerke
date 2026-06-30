// Step-up ("sudo") for the admin surface. An admin re-authenticates (password or TOTP/
// backup code) to obtain a short-lived grant on their session; all other admin endpoints
// require it via requireSudo. These two endpoints require admin but NOT sudo (chicken/egg).
// See AUTH_IMPLEMENTATION_PLAN.md (admin page).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAdmin } from '../auth/guard.ts';
import { grantSudo, sudoActive } from '../auth/session.ts';
import { verifyPassword } from '../auth/password.ts';
import { verifyTotp, consumeBackupCode } from '../lib/totp.ts';
import { recordAudit } from '../lib/audit.ts';

const sudoBody = z.object({ password: z.string().optional(), totp: z.string().optional() });

export async function sudoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  // Whether the current session already has a fresh grant (also the admin-presence probe:
  // a non-admin hits requireAdmin → 404, which the client treats as "not admin").
  app.get('/api/admin/sudo', async (req) => ({ active: await sudoActive(req) }));

  // Re-authenticate to obtain the grant. Accepts a password OR a TOTP/backup code.
  app.post('/api/admin/sudo', async (req, reply) => {
    const b = sudoBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const userId = req.user!.id;

    const rows = await db
      .select({
        passwordHash: schema.users.passwordHash,
        totpEnabled: schema.users.totpEnabled,
        totpSecret: schema.users.totpSecret,
        backupCodes: schema.users.backupCodes,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const u = rows[0];
    if (!u) return reply.code(404).send({ error: 'not found' });

    let ok = false;
    if (b.data.password && u.passwordHash) {
      ok = await verifyPassword(u.passwordHash, b.data.password);
    }
    if (!ok && b.data.totp && u.totpEnabled && u.totpSecret) {
      const code = b.data.totp.trim();
      ok = verifyTotp(u.totpSecret, code);
      if (!ok) {
        const remaining = await consumeBackupCode(u.backupCodes as string[] | null, code);
        if (remaining) {
          await db.update(schema.users).set({ backupCodes: remaining }).where(eq(schema.users.id, userId));
          ok = true;
        }
      }
    }

    req.auditHandled = true;
    if (!ok) {
      recordAudit({ actorId: userId, action: 'sudo_denied', targetType: 'user', targetId: userId, status: 401 });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    await grantSudo(req);
    recordAudit({ actorId: userId, action: 'sudo_granted', targetType: 'user', targetId: userId, status: 200 });
    return reply.send({ ok: true });
  });
}
