import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  deleteUserSessions,
  destroySession,
  resolveUser,
  setSessionCookie,
} from './session.ts';
import { seedUser } from '../lib/seed.ts';
import { recordAudit } from '../lib/audit.ts';
import { sendEmail, appUrl, passwordResetEmail } from '../lib/email.ts';
import { requireAuth } from './guard.ts';
import { getOidc } from './oidc.ts';
import { newSecret, otpauthURL, verifyTotp, newBackupCodes, hashCodes, consumeBackupCode } from '../lib/totp.ts';
import QRCode from 'qrcode';

const credentials = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

const signupBody = credentials.extend({
  inviteCode: z.string().min(1).max(200),
});

const forgotBody = z.object({ email: z.string().email().max(320) });
const resetBody = z.object({ token: z.string().min(1).max(200), password: z.string().min(8).max(200) });
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Login may carry an optional TOTP code (second step of 2FA).
const loginBody = credentials.extend({ totp: z.string().max(10).optional() });
const totpCodeBody = z.object({ code: z.string().min(6).max(20) });

// Login lockout policy.
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

// Stricter rate limit for auth endpoints (brute-force protection).
const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/signup', authRateLimit, async (req, reply) => {
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid credentials' });
    if ((await getOidc()).passwordDisabled) return reply.code(403).send({ error: 'sign-up is disabled — use SSO' });
    const email = parsed.data.email.toLowerCase();

    const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing.length) return reply.code(409).send({ error: 'email already registered' });

    // Atomically consume an invite: only succeeds if it exists, has uses left, and
    // is not expired. The conditional UPDATE makes concurrent reuse safe.
    const now = new Date();
    const consumed = await db
      .update(schema.invites)
      .set({ usedCount: sql`${schema.invites.usedCount} + 1` })
      .where(
        and(
          eq(schema.invites.code, parsed.data.inviteCode),
          lt(schema.invites.usedCount, schema.invites.maxUses),
          or(isNull(schema.invites.expiresAt), gt(schema.invites.expiresAt, now)),
        ),
      )
      .returning({ code: schema.invites.code });
    if (!consumed.length) return reply.code(403).send({ error: 'invalid or exhausted invite code' });

    const id = nanoid();
    const passwordHash = await hashPassword(parsed.data.password);
    await db.insert(schema.users).values({ id, email, passwordHash });
    await seedUser(id);

    const sessionId = await createSession(id);
    setSessionCookie(req, reply, sessionId);
    recordAudit({ actorId: id, action: 'user_signup', targetType: 'user', targetId: id, payload: { email, via: 'invite' }, status: 201 });
    return reply.code(201).send({ user: { id, email, role: 'member', totpEnabled: false } });
  });

  app.post('/api/auth/login', authRateLimit, async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid credentials' });
    const email = parsed.data.email.toLowerCase();

    // When the org has disabled password login, only SSO / passkeys are allowed.
    if ((await getOidc()).passwordDisabled) return reply.code(403).send({ error: 'password login is disabled — use SSO or a passkey' });

    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        passwordHash: schema.users.passwordHash,
        failedAttempts: schema.users.failedAttempts,
        lockedUntil: schema.users.lockedUntil,
        role: schema.users.role,
        totpEnabled: schema.users.totpEnabled,
        totpSecret: schema.users.totpSecret,
        backupCodes: schema.users.backupCodes,
        deactivatedAt: schema.users.deactivatedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    const user = rows[0];

    // Generic 401 for unknown email (don't leak existence).
    if (!user) {
      recordAudit({ actorId: null, action: 'login_failed', targetType: 'user', payload: { email, reason: 'unknown_email' }, status: 401 });
      return reply.code(401).send({ error: 'invalid email or password' });
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      recordAudit({ actorId: null, action: 'login_locked', targetType: 'user', targetId: user.id, payload: { email, reason: 'already_locked' }, status: 429 });
      return reply.code(429).send({ error: `account locked, try again in ${mins} min` });
    }

    // SSO-provisioned accounts have no password.
    if (!user.passwordHash) {
      recordAudit({ actorId: null, action: 'login_failed', targetType: 'user', targetId: user.id, payload: { email, reason: 'no_password' }, status: 401 });
      return reply.code(401).send({ error: 'this account signs in with SSO' });
    }

    if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
      const next = user.failedAttempts + 1;
      const locked = next >= MAX_FAILED;
      await db
        .update(schema.users)
        .set({
          failedAttempts: locked ? 0 : next,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null,
        })
        .where(eq(schema.users.id, user.id));
      recordAudit({
        actorId: null,
        action: locked ? 'login_locked' : 'login_failed',
        targetType: 'user',
        targetId: user.id,
        payload: { email, reason: 'bad_password' },
        status: locked ? 429 : 401,
      });
      return reply.code(locked ? 429 : 401).send({
        error: locked ? 'too many attempts, account locked for 15 min' : 'invalid email or password',
      });
    }

    // Password is correct — but a deactivated account may not sign in. Checked here (after
    // password verify) so it doesn't leak which emails are deactivated.
    if (user.deactivatedAt) {
      recordAudit({ actorId: null, action: 'login_deactivated', targetType: 'user', targetId: user.id, payload: { email }, status: 403 });
      return reply.code(403).send({ error: 'account deactivated' });
    }

    // If 2FA is on, require a valid TOTP (or backup code) before a
    // session is issued. A MISSING code is a challenge (200, no session, no lockout bump);
    // a WRONG code is a failure that counts toward the lockout (throttles code-guessing).
    if (user.totpEnabled && user.totpSecret) {
      const code = parsed.data.totp?.trim();
      if (!code) {
        return reply.send({ totpRequired: true });
      }
      const okTotp = verifyTotp(user.totpSecret, code);
      const remaining = okTotp ? null : await consumeBackupCode(user.backupCodes as string[] | null, code);
      if (!okTotp && !remaining) {
        const next = user.failedAttempts + 1;
        const locked = next >= MAX_FAILED;
        await db
          .update(schema.users)
          .set({ failedAttempts: locked ? 0 : next, lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null })
          .where(eq(schema.users.id, user.id));
        recordAudit({
          actorId: null,
          action: locked ? 'login_locked' : 'totp_failed',
          targetType: 'user',
          targetId: user.id,
          payload: { email, reason: 'bad_totp' },
          status: locked ? 429 : 401,
        });
        return reply.code(locked ? 429 : 401).send({ totpRequired: true, error: locked ? 'account locked' : 'invalid code' });
      }
      if (remaining) {
        // A backup code was used — persist the reduced set so it can't be reused.
        await db.update(schema.users).set({ backupCodes: remaining }).where(eq(schema.users.id, user.id));
      }
    }

    // Success: clear any failure state.
    if (user.failedAttempts !== 0 || user.lockedUntil) {
      await db.update(schema.users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
    }

    const sessionId = await createSession(user.id);
    setSessionCookie(req, reply, sessionId);
    recordAudit({ actorId: user.id, action: 'login_success', targetType: 'user', targetId: user.id, status: 200 });
    return reply.send({ user: { id: user.id, email: user.email, role: user.role === 'admin' ? 'admin' : 'member', totpEnabled: user.totpEnabled } });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const unsigned = req.unsignCookie(token);
      if (unsigned.valid && unsigned.value) await destroySession(unsigned.value);
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // Request a reset link. ALWAYS 200 — never leak whether the email is registered.
  app.post('/api/auth/forgot', authRateLimit, async (req, reply) => {
    const parsed = forgotBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
    const email = parsed.data.email.toLowerCase();

    const rows = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    const user = rows[0];
    if (user) {
      const token = nanoid(32);
      await db.insert(schema.passwordResetTokens).values({ token, userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS) });
      const link = `${appUrl()}/reset?token=${token}`;
      try {
        await sendEmail({ to: user.email, ...passwordResetEmail(link) });
      } catch (err) {
        req.log.error({ err }, 'password reset email failed to send');
      }
      recordAudit({ actorId: null, action: 'password_reset_requested', targetType: 'user', targetId: user.id, payload: { email }, status: 200 });
    }
    return reply.send({ ok: true });
  });

  // Redeem a reset token: set a new password, consume the token, log out everywhere.
  app.post('/api/auth/reset', authRateLimit, async (req, reply) => {
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });

    const now = new Date();
    const rows = await db.select().from(schema.passwordResetTokens).where(eq(schema.passwordResetTokens.token, parsed.data.token)).limit(1);
    const row = rows[0];
    if (!row || row.usedAt || row.expiresAt.getTime() < now.getTime()) {
      return reply.code(400).send({ error: 'invalid or expired token' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    await db.update(schema.users).set({ passwordHash, failedAttempts: 0, lockedUntil: null }).where(eq(schema.users.id, row.userId));
    await db.update(schema.passwordResetTokens).set({ usedAt: now }).where(eq(schema.passwordResetTokens.token, row.token));
    await deleteUserSessions(row.userId); // invalidate all existing sessions
    recordAudit({ actorId: row.userId, action: 'password_reset', targetType: 'user', targetId: row.userId, status: 200 });
    return reply.send({ ok: true });
  });

  // ── MFA / TOTP ──────────────────────────────────────────────────────────
  // Begin enrollment: mint a secret + backup codes, return them (codes shown ONCE),
  // but leave 2FA OFF until a code is verified. Re-enrolling overwrites a pending secret.
  app.post('/api/auth/totp/enroll', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.id;
    const rows = await db.select({ email: schema.users.email, totpEnabled: schema.users.totpEnabled }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const u = rows[0];
    if (!u) return reply.code(404).send({ error: 'not found' });
    if (u.totpEnabled) return reply.code(409).send({ error: 'two-factor already enabled' });

    const secret = newSecret();
    const codes = newBackupCodes();
    await db.update(schema.users).set({ totpSecret: secret, totpEnabled: false, backupCodes: await hashCodes(codes) }).where(eq(schema.users.id, userId));
    const otpauthUrl = otpauthURL(u.email, secret);
    const qr = await QRCode.toDataURL(otpauthUrl);
    return reply.send({ secret, otpauthUrl, qr, backupCodes: codes });
  });

  // Confirm enrollment: a valid code flips 2FA on.
  app.post('/api/auth/totp/verify', { preHandler: requireAuth }, async (req, reply) => {
    const b = totpCodeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid code' });
    const userId = req.user!.id;
    const rows = await db.select({ totpSecret: schema.users.totpSecret }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const secret = rows[0]?.totpSecret;
    if (!secret) return reply.code(400).send({ error: 'not enrolled' });
    if (!verifyTotp(secret, b.data.code)) return reply.code(400).send({ error: 'invalid code' });
    await db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, userId));
    recordAudit({ actorId: userId, action: 'totp_enabled', targetType: 'user', targetId: userId, status: 200 });
    return reply.send({ ok: true });
  });

  // Turn 2FA off — requires a current code or a backup code.
  app.post('/api/auth/totp/disable', { preHandler: requireAuth }, async (req, reply) => {
    const b = totpCodeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid code' });
    const userId = req.user!.id;
    const rows = await db.select({ totpSecret: schema.users.totpSecret, totpEnabled: schema.users.totpEnabled, backupCodes: schema.users.backupCodes }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const u = rows[0];
    if (!u?.totpEnabled || !u.totpSecret) return reply.code(400).send({ error: 'not enabled' });
    const ok = verifyTotp(u.totpSecret, b.data.code) || (await consumeBackupCode(u.backupCodes as string[] | null, b.data.code)) !== null;
    if (!ok) return reply.code(400).send({ error: 'invalid code' });
    await db.update(schema.users).set({ totpSecret: null, totpEnabled: false, backupCodes: null }).where(eq(schema.users.id, userId));
    recordAudit({ actorId: userId, action: 'totp_disabled', targetType: 'user', targetId: userId, status: 200 });
    return reply.send({ ok: true });
  });

  app.get('/api/me', async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.send({ user });
  });
}
