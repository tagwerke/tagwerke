// Bearer-token auth for agent users (AGENT_API.md). Deliberately separate from the session cookie:
// a token works ONLY on /api/agent/*, and a cookie session never works there, so the two worlds
// cannot be confused. The board comes from the token; routes never accept a board id from the caller.

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../db/client.ts';
import { boardRole } from './boards.ts';

export const AGENT_SCOPES = ['board:read', 'task:comment'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

const TOKEN_PREFIX = 'tgw_agent_';

export interface AgentContext {
  tokenId: string;
  userId: string;
  tabId: string;
  scopes: AgentScope[];
  role: string;
  expiresAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentContext;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A fresh secret. 256 bits of randomness, so a plain SHA-256 is a sound at-rest hash. */
export function newToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function isScope(v: unknown): v is AgentScope {
  return typeof v === 'string' && (AGENT_SCOPES as readonly string[]).includes(v);
}

/**
 * preHandler: authenticates `Authorization: Bearer tgw_agent_…`. Every failure is the same bare 401
 * so a caller cannot tell a revoked token from a malformed one. Sets `req.agent`, and `req.user` /
 * `req.boardScope` so the shared audit hook and notify helpers attribute the call correctly.
 */
export async function requireAgent(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deny = () => reply.code(401).send({ error: 'unauthenticated' });
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(TOKEN_PREFIX)) return deny();

  const row = (
    await db
      .select({
        id: schema.agentTokens.id,
        userId: schema.agentTokens.userId,
        tabId: schema.agentTokens.tabId,
        scopes: schema.agentTokens.scopes,
        expiresAt: schema.agentTokens.expiresAt,
        email: schema.users.email,
        kind: schema.users.kind,
        deactivatedAt: schema.users.deactivatedAt,
      })
      .from(schema.agentTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.agentTokens.userId))
      .where(and(eq(schema.agentTokens.tokenHash, hashToken(token)), isNull(schema.agentTokens.revokedAt)))
      .limit(1)
  )[0];
  if (!row || row.kind !== 'agent' || row.deactivatedAt) return deny();
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return deny();
  // The token and the membership must agree. Removing the agent from the board kills the token.
  const role = await boardRole(row.userId, row.tabId);
  if (!role) return deny();

  void db
    .update(schema.agentTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.agentTokens.id, row.id))
    .catch(() => {});

  const scopes = ((row.scopes as unknown[]) ?? []).filter(isScope);
  req.agent = { tokenId: row.id, userId: row.userId, tabId: row.tabId, scopes, role, expiresAt: row.expiresAt };
  req.user = { id: row.userId, email: row.email, role: 'member', totpEnabled: false };
  req.boardScope = row.tabId;
}

/** preHandler factory: the token must carry `scope`. Run after requireAgent. */
export function requireScope(scope: AgentScope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.agent?.scopes.includes(scope)) reply.code(403).send({ error: 'insufficient scope' });
  };
}
