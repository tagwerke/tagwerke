// Server-owned sessions: a random token stored in the `sessions` table, sent to
// the client as a signed HttpOnly cookie. Sliding expiry refreshed on each request.

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../db/client.ts';

export const SESSION_COOKIE = 'do_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Step-up ("sudo") grant lifetime — admin actions require a re-auth this recent.
const SUDO_TTL_MS = 10 * 60 * 1000; // 10 minutes

function expiry(): Date {
  return new Date(nowMs() + SESSION_TTL_MS);
}

// Centralized so it's easy to see the one wall-clock read.
function nowMs(): number {
  return Date.now();
}

export async function createSession(userId: string): Promise<string> {
  const id = nanoid(32);
  await db.insert(schema.sessions).values({ id, userId, expiresAt: expiry() });
  return id;
}

export async function destroySession(id: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

/** Destroy ALL of a user's sessions (log out everywhere) — used by password reset. */
export async function deleteUserSessions(userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/** The current session id from the signed cookie, or null. */
export function sessionIdFromReq(req: FastifyRequest): string | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const unsigned = req.unsignCookie(token);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/** Grant a fresh step-up ("sudo") on the current session. */
export async function grantSudo(req: FastifyRequest): Promise<void> {
  const id = sessionIdFromReq(req);
  if (!id) return;
  await db.update(schema.sessions).set({ sudoAt: new Date() }).where(eq(schema.sessions.id, id));
}

/** True when the current session has a step-up grant within the TTL. */
export async function sudoActive(req: FastifyRequest): Promise<boolean> {
  const id = sessionIdFromReq(req);
  if (!id) return false;
  const rows = await db.select({ sudoAt: schema.sessions.sudoAt }).from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
  const at = rows[0]?.sudoAt;
  return !!at && nowMs() - at.getTime() < SUDO_TTL_MS;
}

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
  totpEnabled: boolean;
}

/** Resolve the logged-in user from the request cookie, refreshing expiry. Returns null if unauthenticated. */
export async function resolveUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const unsigned = req.unsignCookie(token);
  if (!unsigned.valid || !unsigned.value) return null;
  const sessionId = unsigned.value;

  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      userId: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      totpEnabled: schema.users.totpEnabled,
      deactivatedAt: schema.users.deactivatedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < nowMs()) {
    await destroySession(sessionId);
    return null;
  }
  // Deactivated accounts are treated as logged-out and their session is dropped.
  if (row.deactivatedAt) {
    await destroySession(sessionId);
    return null;
  }

  // Sliding expiry refresh.
  await db
    .update(schema.sessions)
    .set({ expiresAt: expiry() })
    .where(eq(schema.sessions.id, sessionId));

  return { id: row.userId, email: row.email, role: row.role === 'admin' ? 'admin' : 'member', totpEnabled: row.totpEnabled };
}

/**
 * Secure cookies only when the request actually arrived over https — directly or via
 * a trusted proxy's X-Forwarded-Proto (trustProxy is on in index.ts). This is what
 * lets a fresh install log in over plain http first and upgrade to a domain later;
 * behind TLS the cookie is always Secure. See docs/self-hosting.md.
 */
export function cookieSecure(req: FastifyRequest): boolean {
  return req.protocol === 'https';
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    signed: true,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
