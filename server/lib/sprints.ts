// Sprint lifecycle (SPRINTS_PLAN.md). Two entry points, each with exactly one implementation
// shared by every caller — see the call sites for why that matters:
//   ensureCurrentSprint — server/routes/tabs.ts (new board) + server/jobs/sprints.ts (rollover)
//   setCurrentSprint    — ensureCurrentSprint (the week turning) + server/routes/sprints.ts (manual)

import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { currentWeekRange } from '../../shared/sprintWeek.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a rollover did, so the caller can record it and tell the board's clients. */
export interface Rollover {
  fromSprintId: string;
  toSprintId: string;
  /** Unfinished tasks carried from the old week's sprint into this one. */
  movedTaskIds: string[];
}

/**
 * Idempotently bring this board's sprints up to the current week. Safe to call unconditionally
 * (board creation, the rollover tick) — `sprints_tab_starts_uniq` makes the seed a no-op on a
 * week already seeded, and the rollover only fires while the current sprint is a past week.
 *
 *  - Seeds this week's sprint.
 *  - If the current sprint is a PAST week, the week has turned: this week's sprint becomes
 *    current and every unfinished task in the old one is carried into it. It used to stop at
 *    "the board already has a current sprint", which after the first week is always true — so
 *    the current sprint froze on the week the board was made and nothing ever rolled.
 *  - If the board has no current sprint at all, this week's is promoted only when it was just
 *    seeded (a new board, or the first tick of a week). Un-starring the current sprint mid-week
 *    is a choice, and the next tick must not quietly undo it.
 */
export async function ensureCurrentSprint(tx: Tx, tabId: string, now: Date): Promise<Rollover | null> {
  const { startsAt, endsAt, label } = currentWeekRange(now);
  const seeded = await tx
    .insert(schema.sprints)
    .values({ id: nanoid(), tabId, label, startsAt, endsAt })
    .onConflictDoNothing({ target: [schema.sprints.tabId, schema.sprints.startsAt] })
    .returning({ id: schema.sprints.id });

  const thisWeek = (
    await tx
      .select({ id: schema.sprints.id })
      .from(schema.sprints)
      .where(and(eq(schema.sprints.tabId, tabId), eq(schema.sprints.startsAt, startsAt)))
      .limit(1)
  )[0];
  if (!thisWeek) return null;

  const current = (
    await tx
      .select({ id: schema.sprints.id, endsAt: schema.sprints.endsAt })
      .from(schema.sprints)
      .where(and(eq(schema.sprints.tabId, tabId), eq(schema.sprints.isCurrent, true)))
      .limit(1)
  )[0];

  if (!current) {
    if (seeded.length) await setCurrentSprint(tx, tabId, thisWeek.id);
    return null;
  }
  // 'YYYY-MM-DD' compares correctly as a string. A current sprint that has not ended is left
  // alone, whichever week it is — someone chose it.
  if (current.endsAt >= startsAt) return null;

  await setCurrentSprint(tx, tabId, thisWeek.id);
  const moved = await tx
    .update(schema.tasks)
    .set({ sprintId: thisWeek.id, updatedAt: now })
    .where(and(
      eq(schema.tasks.homeTabId, tabId),
      eq(schema.tasks.sprintId, current.id),
      isNull(schema.tasks.deletedAt),
      notInArray(schema.tasks.status, ['done', 'cancelled']),
    ))
    .returning({ id: schema.tasks.id });
  return { fromSprintId: current.id, toSprintId: thisWeek.id, movedTaskIds: moved.map((r) => r.id) };
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
