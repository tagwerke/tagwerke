// Board presence — compact "seen by / edited by + time" per member, one row per
// (board, user). Both writes are fire-and-forget upserts: presence is best-effort and
// must never delay or break the underlying request. See AUTH_IMPLEMENTATION_PLAN.md.

import { sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

/** Bump lastSeenAt for (board, user) — called by the "I opened this board" beacon. */
export function touchSeen(tabId: string, userId: string): void {
  void db
    .insert(schema.boardActivity)
    .values({ tabId, userId, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.boardActivity.tabId, schema.boardActivity.userId],
      set: { lastSeenAt: sql`now()` },
    })
    .catch(() => {
      /* best-effort */
    });
}

/** Bump lastEditedAt for (board, user) — called after a successful board write. */
export function touchEdited(tabId: string, userId: string): void {
  void db
    .insert(schema.boardActivity)
    .values({ tabId, userId, lastEditedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.boardActivity.tabId, schema.boardActivity.userId],
      set: { lastEditedAt: sql`now()` },
    })
    .catch(() => {
      /* best-effort */
    });
}
