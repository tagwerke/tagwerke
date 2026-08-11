// Weekly sprint rollout (SPRINTS_PLAN.md). Same shape as jobs/backup.ts: a daily tick that's a
// no-op for any board whose current week is already seeded (ensureCurrentSprint is idempotent
// via sprints_tab_starts_uniq), so it's safe regardless of how long the process has been up.
//
// One board's failure doesn't stop the rest — each gets its own try/catch inside the loop.

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { ensureCurrentSprint } from '../lib/sprints.ts';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let running = false;

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
        await db.transaction((tx) => ensureCurrentSprint(tx, id, now));
      } catch (err) {
        log.error({ err, tabId: id }, 'sprint rollover failed for board — will retry tomorrow');
      }
    }
  } finally {
    running = false;
  }
}

/** Start the daily sprint-rollover loop. unref: never holds the process open. */
export function startSprintRolloverScheduler(log: FastifyBaseLogger): void {
  setTimeout(() => void tick(log), 30_000).unref();
  setInterval(() => void tick(log), INTERVAL_MS).unref();
  log.info('sprint rollover scheduler on (daily)');
}
