// Weekly sprint rollover (SPRINTS_PLAN.md). Same shape as jobs/backup.ts: a periodic tick that's a
// no-op for any board already on this week (ensureCurrentSprint is idempotent), so it's safe
// regardless of how long the process has been up.
//
// Hourly, not daily: a daily timer counts from process start, so the week turned up to a day late
// and every redeploy moved the moment. An hour is as late as Monday gets now.
//
// One board's failure doesn't stop the rest — each gets its own try/catch inside the loop.

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { ensureCurrentSprint, type Rollover } from '../lib/sprints.ts';
import { recordAudit } from '../lib/audit.ts';
import { publish, userChannel } from '../lib/bus.ts';

const INTERVAL_MS = 60 * 60 * 1000; // hourly

let running = false;

/**
 * Say what the rollover did. Each carried task gets its own row — the same `changes` shape a
 * sprint edit writes, so the task's history and the board's history both read it, and a revert
 * can walk back through it. No actor: nobody did this, the week turned.
 */
async function announce(tabId: string, r: Rollover): Promise<void> {
  for (const taskId of r.movedTaskIds) {
    recordAudit({
      actorId: null, action: 'sprint_rollover', targetType: 'task', targetId: taskId, scopeId: tabId,
      payload: { changes: [{ field: 'sprintId', from: r.fromSprintId, to: r.toSprintId }] },
    });
  }
  // A new current sprint changes the sprint list, which has no entity frame of its own; the
  // personal board-list nudge makes each member's client re-pull, the way a share does.
  const members = await db
    .select({ userId: schema.boardMembers.userId })
    .from(schema.boardMembers)
    .where(eq(schema.boardMembers.tabId, tabId));
  for (const { userId } of members) publish(userChannel(userId), { v: 1, type: 'board-list', action: 'sprint', tabId });
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    const boards = await db
      .select({ id: schema.tabs.id })
      .from(schema.tabs)
      .where(eq(schema.tabs.type, 'normal'));
    const now = new Date();
    for (const { id } of boards) {
      try {
        const rolled = await db.transaction((tx) => ensureCurrentSprint(tx, id, now));
        if (rolled) {
          log.info({ tabId: id, moved: rolled.movedTaskIds.length }, 'sprint rolled over');
          await announce(id, rolled);
        }
      } catch (err) {
        log.error({ err, tabId: id }, 'sprint rollover failed for board — will retry next tick');
      }
    }
  } finally {
    running = false;
  }
}

/** Start the hourly sprint-rollover loop. unref: never holds the process open. */
export function startSprintRolloverScheduler(log: FastifyBaseLogger): void {
  setTimeout(() => void tick(log), 30_000).unref();
  setInterval(() => void tick(log), INTERVAL_MS).unref();
  log.info('sprint rollover scheduler on (hourly)');
}
