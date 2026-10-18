// Token management (PAT_PLAN.md): personal access tokens, and the per-board tokens a board admin
// mints for a project's agent. Session-only on purpose: these routes declare no `pat` config, so a
// bearer token — even a PAT with every scope — is refused here (D4: a token cannot mint or revoke
// tokens). Creating one needs a fresh step-up (D5); revoking never does. The board-token routes live
// here rather than in agent.ts because that file's requireAgent hook would capture them.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { sudoActive } from '../auth/session.ts';
import { AGENT_PREFIX, newToken, agentEmail } from '../auth/agent.ts';
import { requireBoardRole, paramTabId } from '../auth/boards.ts';
import { PAT_PREFIX, PAT_SCOPES, isPatScope } from '../auth/pat.ts';
import { notify } from '../lib/notify.ts';
import { recordAudit } from '../lib/audit.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const createBody = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(PAT_SCOPES)).max(PAT_SCOPES.length),
  allBoards: z.boolean(),
  boardIds: z.array(z.string().min(1)).max(200),
  // Expiry is required — there is no "never".
  days: z.union([z.literal(30), z.literal(90), z.literal(365)]),
});

const agentTokenBody = z.object({
  label: z.string().trim().min(1).max(60),
  // `board:read` is always on; these are the optional extras.
  scopes: z.array(z.enum(['task:comment', 'task:write'])).max(2),
  days: z.union([z.literal(30), z.literal(90), z.literal(365)]),
});

const CREATE_RL = { max: 10, timeWindow: '1 minute' } as const;

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // The caller's live tokens. Never the hash, never the secret.
  app.get('/api/tokens', async (req) => {
    const rows = await db
      .select()
      .from(schema.personalAccessTokens)
      .where(
        and(
          eq(schema.personalAccessTokens.userId, req.user!.id),
          isNull(schema.personalAccessTokens.revokedAt),
          gt(schema.personalAccessTokens.expiresAt, new Date()),
        ),
      )
      .orderBy(schema.personalAccessTokens.createdAt);
    return {
      tokens: rows.map((r) => ({
        id: r.id,
        label: r.label,
        scopes: ((r.scopes as unknown[]) ?? []).filter(isPatScope),
        allBoards: r.allBoards,
        boardIds: r.tabIds,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        lastUsedIp: r.lastUsedIp,
      })),
    };
  });

  app.post('/api/tokens', { config: { rateLimit: CREATE_RL } }, async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid token request' });
    if (!(await sudoActive(req))) return reply.code(401).send({ error: 'sudo required' });
    const userId = req.user!.id;

    // A token never reaches a board its owner is not on. "All boards" carries no list.
    const boardIds = b.data.allBoards ? [] : [...new Set(b.data.boardIds)];
    if (boardIds.length) {
      const mine = await db
        .select({ tabId: schema.boardMembers.tabId })
        .from(schema.boardMembers)
        .where(and(eq(schema.boardMembers.userId, userId), inArray(schema.boardMembers.tabId, boardIds)));
      if (mine.length !== boardIds.length) return reply.code(400).send({ error: 'unknown board' });
    }

    const { token, hash } = newToken(PAT_PREFIX);
    const id = nanoid();
    const scopes = [...new Set(b.data.scopes)];
    const expiresAt = new Date(Date.now() + b.data.days * DAY_MS);
    await db.insert(schema.personalAccessTokens).values({
      id, userId, label: b.data.label, tokenHash: hash, scopes, allBoards: b.data.allBoards, tabIds: boardIds, expiresAt,
    });

    req.auditHandled = true;
    recordAudit({
      actorId: userId, action: 'token_created', targetType: 'token', targetId: id, method: 'POST', status: 201,
      payload: { label: b.data.label, scopes, allBoards: b.data.allBoards, boardIds, expiresAt: expiresAt.toISOString() },
    });
    // The owner is told about every new token (D5) — the label, never the secret.
    notify(userId, { type: 'token_created', title: 'Access token created', body: b.data.label });

    return reply.code(201).send({
      id, token, label: b.data.label, scopes, allBoards: b.data.allBoards, boardIds, expiresAt: expiresAt.toISOString(),
    });
  });

  // Revoke. Owner only; no step-up (revoking is always safe). Idempotent.
  app.delete('/api/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const row = (
      await db
        .select({ label: schema.personalAccessTokens.label, revokedAt: schema.personalAccessTokens.revokedAt })
        .from(schema.personalAccessTokens)
        .where(and(eq(schema.personalAccessTokens.id, id), eq(schema.personalAccessTokens.userId, userId)))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!row.revokedAt) {
      await db
        .update(schema.personalAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.personalAccessTokens.id, id));
      req.auditHandled = true;
      recordAudit({
        actorId: userId, action: 'token_revoked', targetType: 'token', targetId: id, method: 'DELETE', status: 200,
        payload: { label: row.label },
      });
    }
    return reply.send({ ok: true });
  });

  // ---- per-board agent tokens ---------------------------------------------------------------------
  // The token belongs to the BOARD, not to whoever minted it, so it outlives its creator. Each one
  // gets its own agent user: editor when it can write tasks, viewer otherwise. What the agent may
  // actually do is still decided only by /api/agent/*.

  app.get('/api/tabs/:id/agent-tokens', { preHandler: requireBoardRole('admin', paramTabId) }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(schema.agentTokens)
      .where(and(eq(schema.agentTokens.tabId, id), isNull(schema.agentTokens.revokedAt)))
      .orderBy(schema.agentTokens.createdAt);
    return {
      tokens: rows
        .filter((r) => !r.expiresAt || r.expiresAt.getTime() > Date.now())
        .map((r) => ({
          id: r.id,
          agentUserId: r.userId,
          label: r.label,
          scopes: r.scopes,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        })),
    };
  });

  app.post(
    '/api/tabs/:id/agent-tokens',
    { preHandler: requireBoardRole('admin', paramTabId), config: { rateLimit: CREATE_RL } },
    async (req, reply) => {
      const { id: tabId } = req.params as { id: string };
      const b = agentTokenBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid token request' });
      if (!(await sudoActive(req))) return reply.code(401).send({ error: 'sudo required' });
      const userId = req.user!.id;

      const scopes = ['board:read', ...new Set(b.data.scopes)];
      const writes = scopes.includes('task:write');
      const agentId = nanoid();
      const tokenId = nanoid();
      const { token, hash } = newToken(AGENT_PREFIX);
      const expiresAt = new Date(Date.now() + b.data.days * DAY_MS);
      await db.transaction(async (tx) => {
        await tx.insert(schema.users).values({ id: agentId, email: agentEmail(b.data.label), role: 'member', kind: 'agent' });
        await tx.insert(schema.boardMembers).values({ tabId, userId: agentId, role: writes ? 'editor' : 'viewer' });
        await tx.insert(schema.agentTokens).values({
          id: tokenId, userId: agentId, tabId, tokenHash: hash, scopes, label: b.data.label, createdBy: userId, expiresAt,
        });
      });

      req.auditHandled = true;
      recordAudit({
        actorId: userId, action: 'agent_token_created', targetType: 'tab', targetId: tabId, scopeId: tabId, method: 'POST', status: 201,
        payload: { tokenId, label: b.data.label, scopes, expiresAt: expiresAt.toISOString() },
      });
      return reply.code(201).send({ id: tokenId, token, label: b.data.label, scopes, expiresAt: expiresAt.toISOString() });
    },
  );

  // Revoke, and take the agent off the board (requireAgent also refuses a token whose agent is no
  // longer a member, so the two cannot disagree). Admin only; no step-up.
  app.delete('/api/tabs/:id/agent-tokens/:tokenId', { preHandler: requireBoardRole('admin', paramTabId) }, async (req, reply) => {
    const { id: tabId, tokenId } = req.params as { id: string; tokenId: string };
    const row = (
      await db
        .select({ userId: schema.agentTokens.userId, label: schema.agentTokens.label })
        .from(schema.agentTokens)
        .where(and(eq(schema.agentTokens.id, tokenId), eq(schema.agentTokens.tabId, tabId)))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: 'not found' });
    await db.transaction(async (tx) => {
      await tx.update(schema.agentTokens).set({ revokedAt: new Date() }).where(and(eq(schema.agentTokens.id, tokenId), isNull(schema.agentTokens.revokedAt)));
      await tx.delete(schema.boardMembers).where(and(eq(schema.boardMembers.tabId, tabId), eq(schema.boardMembers.userId, row.userId)));
    });
    req.auditHandled = true;
    recordAudit({
      actorId: req.user!.id, action: 'agent_token_revoked', targetType: 'tab', targetId: tabId, scopeId: tabId, method: 'DELETE', status: 200,
      payload: { tokenId, label: row.label },
    });
    return reply.send({ ok: true });
  });

}
