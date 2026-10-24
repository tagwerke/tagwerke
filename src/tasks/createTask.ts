// The one way a task comes into existence outside the document (NOTES_SPLIT_PLAN §N1).
//
// This is `taskTree.createSiblingAfter` with its single document-shaped line made conditional. The
// ROW is the task; a doc ref is something the Doc view happens to also want while it still exists.
// Everything else — mint an id, compute a rank, write the store row, let persist.ts diff it out as
// a PUT — is the path every SUB-task has always taken, because a child never had a ref to write.
// That is why this needs no new persistence wiring: `fullBody` in persist.ts already sends
// homeTabId, rank and parentTaskId, and `topoOrderCreates` already orders parents before children.

import { nanoid } from 'nanoid';
import { siblingsOf, useStore } from '../store';
import { rankAfter, rankBetween } from '../../shared/rank';
import type { ID, TaskStatus } from '../types';
import { isDoneStatus } from '../../shared/status';

/** Fields a `/command`, `@mention` or `!` sigil set on the line before it became a task. */
export interface DraftFields {
  status?: TaskStatus;
  date?: string | null;
  priority?: 1 | 2 | 3 | null;
  assigneeId?: ID | null;
  /** A filtered board starts new tasks in the sprint it is filtered to. Null/omitted is the backlog. */
  sprintId?: ID | null;
}

export interface CreateTaskOptions {
  text: string;
  fields?: DraftFields;
  /** Nest under this task. Omitted → a top-level task. */
  parentTaskId?: ID;
  /** Place it after this sibling. Omitted → append after the last one. */
  after?: ID;
}

/** Create a task on a board and return its id. */
export function createTaskInBoard(tabId: ID, opts: CreateTaskOptions): ID {
  const store = useStore.getState();
  const { text, fields, parentTaskId, after } = opts;

  const sibs = siblingsOf(store.tasks, tabId, parentTaskId);
  const anchor = after ? sibs.find((s) => s.id === after) : undefined;
  const next = anchor ? sibs[sibs.indexOf(anchor) + 1] : undefined;
  let rank: string | undefined;
  try {
    rank = anchor
      ? rankBetween(anchor.rank ?? null, next?.rank ?? null)
      : rankAfter(sibs[sibs.length - 1]?.rank ?? null);
  } catch {
    rank = undefined; // neighbours unranked or out of order — let the store append
  }

  const id = `t_${nanoid(8)}`;
  const status = fields?.status;
  store.upsertTask({
    id,
    homeTabId: tabId,
    text,
    parentTaskId,
    rank,
    ...(status ? { status, done: isDoneStatus(status) } : {}),
    ...(fields?.date !== undefined ? { date: fields.date ?? undefined } : {}),
    ...(fields?.priority !== undefined ? { priority: fields.priority ?? undefined } : {}),
    ...(fields?.assigneeId !== undefined ? { assigneeId: fields.assigneeId ?? undefined } : {}),
    ...(fields?.sprintId ? { sprintId: fields.sprintId } : {}),
  });

  return id;
}
