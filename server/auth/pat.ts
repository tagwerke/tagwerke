// Personal access tokens (PAT_PLAN.md). A PAT acts AS ITS OWNER on the normal /api/* routes, limited
// to the scopes ticked at creation and to the boards the owner listed (or all of them).
//
// Authentication happens in `requireAuth` and nowhere else; `resolveUser` stays cookie-only, which
// is what keeps tokens out of admin routes and the websocket. The security model is DENY BY DEFAULT:
// a route is reachable with a token only if it declares `config: { pat: 'read' | <scope> }`. Secrets,
// sudo, TOTP, passkeys, token management and everything else use `requireAuth` and never opt in, so
// a token gets 403 there with no per-route code.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../db/client.ts';
import { hashToken } from './agent.ts';

export const PAT_PREFIX = 'tgw_pat_';

/** What a token can WRITE. Reading its boards is implied for every token. */
export const PAT_SCOPES = ['tasks', 'comments', 'boards'] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

/** A route's declaration: `'read'` (any token) or the one write scope it needs. */
type PatRouteAccess = 'read' | PatScope;

export interface PatContext {
  id: string;
  label: string;
  scopes: ReadonlySet<PatScope>;
  allBoards: boolean;
  tabIds: ReadonlySet<string>;
}

declare module 'fastify' {
  interface FastifyRequest {
    pat?: PatContext;
  }
  interface FastifyContextConfig {
    pat?: PatRouteAccess;
  }
}

export function isPatScope(v: unknown): v is PatScope {
  return typeof v === 'string' && (PAT_SCOPES as readonly string[]).includes(v);
}

/** The `Authorization: Bearer …` token if it is a PAT, else null (so the cookie path runs). */
export function patFromHeader(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.startsWith(PAT_PREFIX) ? token : null;
}

/**
 * Authenticate a PAT and apply the route's declaration. Every authentication failure is the same bare
 * 401, so a caller cannot tell a revoked token from an expired or malformed one. Returns true when the
 * request may proceed.
 */
export async function authenticatePat(req: FastifyRequest, reply: FastifyReply, token: string): Promise<boolean> {
  const deny = () => {
    reply.code(401).send({ error: 'unauthenticated' });
    return false;
  };

  const row = (
    await db
      .select({
        id: schema.personalAccessTokens.id,
        label: schema.personalAccessTokens.label,
        scopes: schema.personalAccessTokens.scopes,
        allBoards: schema.personalAccessTokens.allBoards,
        tabIds: schema.personalAccessTokens.tabIds,
        expiresAt: schema.personalAccessTokens.expiresAt,
        userId: schema.users.id,
        email: schema.users.email,
        totpEnabled: schema.users.totpEnabled,
        kind: schema.users.kind,
        deactivatedAt: schema.users.deactivatedAt,
      })
      .from(schema.personalAccessTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.personalAccessTokens.userId))
      .where(and(eq(schema.personalAccessTokens.tokenHash, hashToken(token)), isNull(schema.personalAccessTokens.revokedAt)))
      .limit(1)
  )[0];
  if (!row || row.kind !== 'human' || row.deactivatedAt) return deny();
  if (row.expiresAt.getTime() < Date.now()) return deny();

  void db
    .update(schema.personalAccessTokens)
    .set({ lastUsedAt: new Date(), lastUsedIp: req.ip })
    .where(eq(schema.personalAccessTokens.id, row.id))
    .catch(() => {});

  const scopes = new Set(((row.scopes as unknown[]) ?? []).filter(isPatScope));
  req.pat = { id: row.id, label: row.label, scopes, allBoards: row.allBoards, tabIds: new Set(row.tabIds) };
  // Never 'admin': even if the owner is a platform admin, a token must not carry that (D4).
  req.user = { id: row.userId, email: row.email, role: 'member', totpEnabled: row.totpEnabled };

  const access = req.routeOptions.config.pat;
  if (!access) {
    reply.code(403).send({ error: 'not available to tokens' });
    return false;
  }
  if (access !== 'read' && !scopes.has(access)) {
    reply.code(403).send({ error: 'insufficient scope' });
    return false;
  }
  return true;
}

/** True for a cookie session, or for a token that reaches `tabId`. */
export function patReaches(req: FastifyRequest, tabId: string): boolean {
  return !req.pat || req.pat.allBoards || req.pat.tabIds.has(tabId);
}

/** A board created through a token joins its list (unless it already reaches every board). */
export async function patAddBoard(req: FastifyRequest, tabId: string): Promise<void> {
  if (!req.pat || req.pat.allBoards) return;
  await db
    .update(schema.personalAccessTokens)
    .set({ tabIds: sql`array_append(${schema.personalAccessTokens.tabIds}, ${tabId})` })
    .where(eq(schema.personalAccessTokens.id, req.pat.id));
}

/** Audit payload fields that say a write came through a token (empty for a cookie session). */
export function tokenStamp(req: { pat?: { id: string; label: string } }): { via?: 'pat'; tokenId?: string; tokenLabel?: string } {
  return req.pat ? { via: 'pat', tokenId: req.pat.id, tokenLabel: req.pat.label } : {};
}
