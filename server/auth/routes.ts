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
  destroySession,
  resolveUser,
  setSessionCookie,
} from './session.ts';
import { seedUser } from '../lib/seed.ts';

const credentials = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

const signupBody = credentials.extend({
  inviteCode: z.string().min(1).max(200),
});

// Login lockout policy.
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

// Stricter rate limit for auth endpoints (brute-force protection).
const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/signup', authRateLimit, async (req, reply) => {
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid credentials' });
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
    setSessionCookie(reply, sessionId);
    return reply.code(201).send({ user: { id, email } });
  });

  app.post('/api/auth/login', authRateLimit, async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid credentials' });
    const email = parsed.data.email.toLowerCase();

    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        passwordHash: schema.users.passwordHash,
        failedAttempts: schema.users.failedAttempts,
        lockedUntil: schema.users.lockedUntil,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    const user = rows[0];

    // Generic 401 for unknown email (don't leak existence).
    if (!user) return reply.code(401).send({ error: 'invalid email or password' });

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return reply.code(429).send({ error: `account locked, try again in ${mins} min` });
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
      return reply.code(locked ? 429 : 401).send({
        error: locked ? 'too many attempts, account locked for 15 min' : 'invalid email or password',
      });
    }

    // Success: clear any failure state.
    if (user.failedAttempts !== 0 || user.lockedUntil) {
      await db.update(schema.users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
    }

    const sessionId = await createSession(user.id);
    setSessionCookie(reply, sessionId);
    return reply.send({ user: { id: user.id, email: user.email } });
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

  app.get('/api/me', async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.send({ user });
  });
}
