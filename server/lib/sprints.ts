// Sprint lifecycle (SPRINTS_PLAN.md). Two entry points, each with exactly one implementation
// shared by every caller — see the call sites for why that matters:
//   ensureCurrentSprint — server/routes/tabs.ts (new board) + server/jobs/sprints.ts (weekly)
//   setCurrentSprint    — server/jobs/sprints.ts (auto-promote) + server/routes/sprints.ts (manual)

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { currentWeekRange } from '../../shared/sprintWeek.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Idempotently seed this board's current-week sprint and, if the board has no current
 * sprint at all, promote it. Safe to call unconditionally (board creation, daily rollout
 * tick) — `sprints_tab_starts_uniq` makes the insert a no-op on a week already seeded.
 */
export async function ensureCurrentSprint(tx: Tx, tabId: string, now: Date): Promise<void> {
  const { startsAt, endsAt, label } = currentWeekRange(now);
  await tx
    .insert(schema.sprints)
    .values({ id: nanoid(), tabId, label, startsAt, endsAt })
    .onConflictDoNothing({ target: [schema.sprints.tabId, schema.sprints.startsAt] });

  const hasCurrent = (
    await tx
      .select({ id: schema.sprints.id })
      .from(schema.sprints)
      .where(and(eq(schema.sprints.tabId, tabId), eq(schema.sprints.isCurrent, true)))
      .limit(1)
  )[0];
  if (hasCurrent) return;

  const thisWeek = (
    await tx
      .select({ id: schema.sprints.id })
      .from(schema.sprints)
      .where(and(eq(schema.sprints.tabId, tabId), eq(schema.sprints.startsAt, startsAt)))
      .limit(1)
  )[0];
  if (thisWeek) await setCurrentSprint(tx, tabId, thisWeek.id);
}

/** Atomically make `sprintId` the one current sprint for `tabId`, un-setting any other. */
export async function setCurrentSprint(tx: Tx, tabId: string, sprintId: string): Promise<void> {
  await tx
    .update(schema.sprints)
    .set({ isCurrent: false })
    .where(and(eq(schema.sprints.tabId, tabId), eq(schema.sprints.isCurrent, true)));
  await tx
    .update(schema.sprints)
    .set({ isCurrent: true })
    .where(and(eq(schema.sprints.tabId, tabId), eq(schema.sprints.id, sprintId)));
}
