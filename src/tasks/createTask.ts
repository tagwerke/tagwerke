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
import { getEditor } from '../editor/registry';
import { insertRefAfter } from '../editor/docRefs';
import type { ID, TaskStatus } from '../types';

/** Fields a `/command`, `@mention` or `!` sigil set on the line before it became a task. */
export interface DraftFields {
  status?: TaskStatus;
  date?: string | null;
  priority?: 1 | 2 | 3 | null;
  assigneeId?: ID | null;
}

export interface CreateTaskOptions {
  text: string;
  fields?: DraftFields;
  /** Nest under this task. Omitted → a top-level task. */
  parentTaskId?: ID;
  /** Place it after this sibling. Omitted → append after the last one. */
  after?: ID;
}

/**
 * On a board that requires review, `done` is reachable only through the in_review → done approval;
 * the server rejects a direct jump, including on create (`routes/tasks.ts`). Mirror that here so
 * quick-adding "ship it /done" submits for review instead of firing a write the server bounces —
 * a rejected write is poison to the outbox, which drops it and repulls the world. This is the same
 * rule `store.reviewGate` applies to an existing task, applied at birth.
 */
function gateStatus(tabId: ID, status: TaskStatus | undefined): TaskStatus | undefined {
  if (status !== 'done') return status;
  return useStore.getState().tabs[tabId]?.settings?.requireReview ? 'in_review' : status;
}

/**
 * Create a task on a board and return its id.
 *
 * The document ref is written only when a Doc view for this board is actually mounted. When it is
 * not — the common case once the Table is the default — the row simply has no ref, and the
 * board-open reconcile (§N1.4, `server/realtime/ydoc.ts`) writes one the next time someone opens
 * the document. Both halves disappear in §N5 along with the refs themselves.
 */
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
  const status = gateStatus(tabId, fields?.status);
  store.upsertTask({
    id,
    homeTabId: tabId,
    text,
    parentTaskId,
    rank,
    ...(status ? { status, done: status === 'done' } : {}),
    ...(fields?.date !== undefined ? { date: fields.date ?? undefined } : {}),
    ...(fields?.priority !== undefined ? { priority: fields.priority ?? undefined } : {}),
    ...(fields?.assigneeId !== undefined ? { assigneeId: fields.assigneeId ?? undefined } : {}),
  });

  // Only a ROOT has a slot in the prose (SUBTASKS_PLAN D2), and only if the doc is on screen.
  if (!parentTaskId) {
    const editor = getEditor(tabId);
    if (editor?.isEditable) insertRefAfter(editor, anchor?.id ?? sibs[sibs.length - 1]?.id ?? null, id);
  }

  return id;
}
