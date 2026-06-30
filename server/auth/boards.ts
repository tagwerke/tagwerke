// Board-level authorization. Access derives from board_members (v2 collaboration),
// not from a user_id column on the row. `boardRole` is the single source of truth;
// `requireBoardRole` is a Fastify preHandler factory that gates a route on a minimum
// role for the board it targets.
//
// 404 (not 403) is returned when the caller has NO membership, so the existence of a
// board you're not on is not probeable. 403 is only for "you're on it but ranked too
// low" — which already implies you can see the board.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

declare module 'fastify' {
  interface FastifyRequest {
    // The board id resolved during the permission check, stashed so downstream
    // (the audit hook, board-activity) can scope a write to its board for free —
    // no second lookup. Set by requireBoardRole.
    boardScope?: string;
  }
}

export type BoardRole = 'viewer' | 'editor' | 'admin';

const RANK: Record<BoardRole, number> = { viewer: 1, editor: 2, admin: 3 };

function isRole(v: unknown): v is BoardRole {
  return v === 'viewer' || v === 'editor' || v === 'admin';
}

/** The caller's role on a board, or null when they are not a member. */
export async function boardRole(userId: string, tabId: string): Promise<BoardRole | null> {
  const rows = await db
    .select({ role: schema.boardMembers.role })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.tabId, tabId), eq(schema.boardMembers.userId, userId)))
    .limit(1);
  const r = rows[0]?.role;
  return isRole(r) ? r : null;
}

/** True when the caller is at least `min` on the board. */
export async function hasBoardRole(userId: string, tabId: string, min: BoardRole): Promise<boolean> {
  const role = await boardRole(userId, tabId);
  return role != null && RANK[role] >= RANK[min];
}

type TabIdResolver = (req: FastifyRequest) => string | undefined | Promise<string | undefined>;

/** Common resolver: the board id is the `:id` route param. */
export const paramTabId: TabIdResolver = (req) => (req.params as { id: string }).id;

/**
 * preHandler factory: requires the caller to be at least `min` on the board returned
 * by `getTabId`. Must run AFTER requireAuth (reads req.user). Replies and stops on
 * failure; on success leaves req untouched so the handler proceeds.
 */
export function requireBoardRole(min: BoardRole, getTabId: TabIdResolver) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const tabId = await getTabId(req);
    if (!tabId) {
      reply.code(400).send({ error: 'missing board reference' });
      return;
    }
    req.boardScope = tabId; // for the audit hook / board-activity; resolved here anyway
    const role = await boardRole(userId, tabId);
    if (!role) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    if (RANK[role] < RANK[min]) {
      reply.code(403).send({ error: 'insufficient permission' });
      return;
    }
  };
}
