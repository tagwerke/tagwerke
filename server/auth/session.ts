// Server-owned sessions: a random token stored in the `sessions` table, sent to
// the client as a signed HttpOnly cookie. Sliding expiry refreshed on each request.

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../db/client.ts';

export const SESSION_COOKIE = 'do_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
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

  // Sliding expiry refresh.
  await db
    .update(schema.sessions)
    .set({ expiresAt: expiry() })
    .where(eq(schema.sessions.id, sessionId));

  return { id: row.userId, email: row.email, role: row.role === 'admin' ? 'admin' : 'member' };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    signed: true,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
