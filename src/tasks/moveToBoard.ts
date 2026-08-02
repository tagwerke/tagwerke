// Moving a task — and the work under it — to another board.
//
// The whole operation is ONE server call (POST /api/tasks/:id/move). Nothing is applied
// optimistically, which is unusual here and deliberate: the destination's placement and roster are
// facts only the server has, and guessing at them would mean rendering a board state that is about
// to be corrected. The round trip buys an exact result, and this is a considered command (picked
// from a menu), not a keystroke that has to feel instant.
//
// Nor does anything touch the DOCUMENTS. A root task's ref has to leave the source board's doc and
// appear in the destination's, but the server already does both in its reconcile pass, and those
// edits arrive here over the live Yjs channel like any other peer's. Doing it client-side too
// would just race with them.

import { api, drain, type MoveResult } from '../api/client';
import { applyServerState, flush } from '../api/persist';
import { useStore } from '../store';
import type { ID, Tab } from '../types';

/**
 * Boards this task could be moved to: every board the caller can edit, except the one it is on.
 * The role check mirrors the server, which requires editor on BOTH boards — offering a board the
 * move would be refused on is worse than not offering it.
 */
export function moveTargets(tabs: Record<ID, Tab>, homeTabId: ID | undefined): Tab[] {
  return Object.values(tabs)
    .filter((t) => t.id !== homeTabId && t.type !== 'today' && t.role !== 'viewer')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Human-readable summary of what a move did, for the toast. Names the assignment losses. */
export function describeMove(result: MoveResult, boardName: string): string {
  const parts: string[] = [`Moved to ${boardName}`];
  if (result.subtaskCount) parts.push(`with ${result.subtaskCount} sub-task${result.subtaskCount === 1 ? '' : 's'}`);
  const cleared = result.clearedAssignees + result.clearedReviewers;
  if (cleared) {
    // Said plainly: the destination board's roster could not hold the assignment, so it is gone.
    // The audit row names who lost it; this line makes sure the mover knows it happened at all.
    parts.push(`— ${cleared} assignment${cleared === 1 ? '' : 's'} cleared (not a member of that board)`);
  }
  return parts.join(' ');
}

/**
 * Move `id` (and its sub-tasks) to `toTabId`. Applies the rows the server rewrote verbatim — they
 * are complete, so they REPLACE the local ones rather than merging: a field the server dropped
 * (a cleared assignee) is absent from the DTO, and merging would keep the stale value.
 *
 * Throws on failure (offline, or a board the caller may not write) — the caller reports it.
 */
export async function moveTaskToBoard(id: ID, toTabId: ID): Promise<MoveResult> {
  // Let queued edits land first. Field writes go through the FIFO outbox; this call does not, so
  // it would otherwise overtake a title the user typed a moment ago — the server would read the
  // pre-edit row, and the DTO we apply below would put the stale title back on screen. Flushing
  // the differ and waiting for the queue costs a beat and keeps what you see accurate.
  flush();
  await drain();
  const result = await api.tasks.move(id, toTabId);
  if (result.moved.length) {
    applyServerState(() =>
      useStore.setState((s) => {
        const tasks = { ...s.tasks };
        for (const t of result.moved) tasks[t.id] = t;
        return { tasks };
      }),
    );
  }
  return result;
}
