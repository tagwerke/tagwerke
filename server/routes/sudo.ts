// Step-up ("sudo"). A user re-authenticates (password or TOTP/backup code, or a passkey) to obtain
// a short-lived grant on their session. These endpoints require a session but NOT sudo (chicken/egg).
// See AUTH_IMPLEMENTATION_PLAN.md (admin page).
//
// Mounted twice, one implementation:
//   /api/admin/sudo — platform admins, fronting the admin surface (requireSudo there).
//   /api/auth/sudo  — any signed-in user, fronting board secrets (SECRET_LINKS_PLAN). A board admin
//                     is usually not a platform admin, so the admin mount cannot serve them. The
//                     grant is the same per-session `sudo_at`; it confers nothing on its own — every
//                     route it fronts still checks its own role first.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { db, schema } from '../db/client.ts';
import { requireAdmin, requireAuth } from '../auth/guard.ts';
import { grantSudo, sudoActive } from '../auth/session.ts';
import { verifyPassword } from '../auth/password.ts';
import { verifyTotp, consumeBackupCode } from '../lib/totp.ts';
import { webauthnRp, setWebauthnChallenge, readWebauthnChallenge, clearWebauthnChallenge } from '../auth/webauthn.ts';
import { recordAudit } from '../lib/audit.ts';

const sudoBody = z.object({ password: z.string().optional(), totp: z.string().optional() });

// A step-up checks a password, so it gets the login endpoints' limit. Without one, a stolen session
// cookie could brute-force its way to a grant.
const SUDO_RL = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function stepUpRoutes(base: string, guard: Guard) {
  return async function (app: FastifyInstance): Promise<void> {
    app.addHook('preHandler', guard);

    // Whether the current session already has a fresh grant (on the admin mount, also the
    // admin-presence probe: a non-admin hits requireAdmin → 404, which the client treats as "not admin").
    app.get(base, async (req) => ({ active: await sudoActive(req) }));

    // Re-authenticate to obtain the grant. Accepts a password OR a TOTP/backup code.
    app.post(base, SUDO_RL, async (req, reply) => {
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

      // Step-up must re-prove EVERY factor the user has configured — mirroring login
      // (routes.ts). Password alone must NOT elevate a 2FA-enrolled admin, or the sudo gate
      // (which fronts role changes, 2FA resets, deactivations) would be weaker than login.
      const hasPassword = !!u.passwordHash;
      const passwordOk = hasPassword && !!b.data.password && (await verifyPassword(u.passwordHash!, b.data.password));

      let totpOk = false;
      if (u.totpEnabled && u.totpSecret && b.data.totp) {
        const code = b.data.totp.trim();
        totpOk = verifyTotp(u.totpSecret, code);
        if (!totpOk) {
          const remaining = await consumeBackupCode(u.backupCodes as string[] | null, code);
          if (remaining) {
            await db.update(schema.users).set({ backupCodes: remaining }).where(eq(schema.users.id, userId));
            totpOk = true;
          }
        }
      }

      // Each configured factor must be satisfied, and at least one real credential must have
      // been verified (so a no-password/no-TOTP SSO account can't elevate here with nothing —
      // it must use the passkey path below).
      const passwordSatisfied = !hasPassword || passwordOk;
      const totpSatisfied = !u.totpEnabled || totpOk;
      const ok = passwordSatisfied && totpSatisfied && (passwordOk || totpOk);

      req.auditHandled = true;
      if (!ok) {
        recordAudit({ actorId: userId, action: 'sudo_denied', targetType: 'user', targetId: userId, status: 401 });
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      await grantSudo(req);
      recordAudit({ actorId: userId, action: 'sudo_granted', targetType: 'user', targetId: userId, status: 200 });
      return reply.send({ ok: true });
    });

    // Passkey step-up — the elevation path for admins who sign in via SSO (no password/TOTP).
    app.post(`${base}/passkey/options`, SUDO_RL, async (req, reply) => {
      const creds = await db
        .select({ credentialId: schema.webauthnCredentials.credentialId, transports: schema.webauthnCredentials.transports })
        .from(schema.webauthnCredentials)
        .where(eq(schema.webauthnCredentials.userId, req.user!.id));
      if (!creds.length) return reply.code(400).send({ error: 'no passkey registered' });
      const { rpID } = webauthnRp();
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'preferred',
        allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: (c.transports as AuthenticatorTransportFuture[] | null) ?? undefined })),
      });
      setWebauthnChallenge(req, reply, options.challenge);
      return options;
    });

    app.post(`${base}/passkey/verify`, SUDO_RL, async (req, reply) => {
      const challenge = readWebauthnChallenge(req);
      clearWebauthnChallenge(reply);
      if (!challenge) return reply.code(400).send({ error: 'no challenge' });
      const body = req.body as { response: AuthenticationResponseJSON };
      const credId = body.response?.id;
      if (!credId) return reply.code(400).send({ error: 'invalid response' });

      const rows = await db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.credentialId, credId)).limit(1);
      const cred = rows[0];
      // The passkey must belong to the elevating admin.
      if (!cred || cred.userId !== req.user!.id) return reply.code(401).send({ error: 'invalid passkey' });

      const { rpID, origin } = webauthnRp();
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: cred.credentialId,
            publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
            counter: cred.counter,
            transports: (cred.transports as AuthenticatorTransportFuture[] | null) ?? undefined,
          },
          requireUserVerification: false,
        });
      } catch {
        return reply.code(401).send({ error: 'verification failed' });
      }
      if (!verification.verified) return reply.code(401).send({ error: 'not verified' });

      await db
        .update(schema.webauthnCredentials)
        .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
        .where(eq(schema.webauthnCredentials.id, cred.id));

      req.auditHandled = true;
      await grantSudo(req);
      recordAudit({ actorId: req.user!.id, action: 'sudo_granted', targetType: 'user', targetId: req.user!.id, payload: { via: 'passkey' }, status: 200 });
      return reply.send({ ok: true });
    });
  };
}

export const sudoRoutes = stepUpRoutes('/api/admin/sudo', requireAdmin);
export const accountSudoRoutes = stepUpRoutes('/api/auth/sudo', requireAuth);
