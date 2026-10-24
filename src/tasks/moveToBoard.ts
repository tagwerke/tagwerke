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

import { api, ApiError, drain, type MoveResult } from '../api/client';
import { applyServerState, flush } from '../api/persist';
import { descendantsOf, useStore } from '../store';
import { askStateMapping } from '../confirm/prompts';
import type { MapSource } from '../components/states/StateMapper';
import { stateOf, statesOf, suggestMapping, visibleStatesOf } from './states';
import type { BoardState } from '../../shared/status';
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
  const cleared = result.clearedAssignees;
  if (cleared) {
    // Said plainly: the destination board's roster could not hold the assignment, so it is gone.
    // The audit row names who lost it; this line makes sure the mover knows it happened at all.
    parts.push(`— ${cleared} assignment${cleared === 1 ? '' : 's'} cleared (not a member of that board)`);
  }
  const changed = (result.stateChanges ?? []).reduce((n, c) => n + c.count, 0);
  if (changed) parts.push(`— ${changed} task${changed === 1 ? '' : 's'} changed state`);
  return parts.join(' ');
}

/** The states in the subtree the destination lacks, as the mapper shows them. A key the destination
 *  also has carries over unasked (D9). */
function unmappedStates(id: ID, toTabId: ID): MapSource[] {
  const tasks = useStore.getState().tasks;
  const task = tasks[id];
  if (!task) return [];
  const dest = new Set(statesOf(toTabId).map((s) => s.key));
  const counts = new Map<string, number>();
  for (const t of [task, ...descendantsOf(tasks, id)]) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  return [...counts]
    .filter(([key]) => !dest.has(key))
    .map(([key, count]) => {
      const s = stateOf(task.homeTabId, key);
      return { key, label: s.label, category: s.category, color: s.color, count };
    });
}

/**
 * Move `id` (and its sub-tasks) to `toTabId`. Applies the rows the server rewrote verbatim — they
 * are complete, so they REPLACE the local ones rather than merging: a field the server dropped
 * (a cleared assignee) is absent from the DTO, and merging would keep the stale value.
 *
 * When the destination lacks some of the subtree's states, asks where they go first. Resolves null
 * when that question is cancelled. Throws on failure (offline, or a board the caller may not
 * write) — the caller reports it.
 */
export async function moveTaskToBoard(id: ID, toTabId: ID, boardName: string): Promise<MoveResult | null> {
  const ask = (sources: MapSource[], targets: readonly BoardState[], prior: Record<string, string> = {}) =>
    askStateMapping(boardName, sources, targets, { ...suggestMapping(sources, targets), ...prior });

  const sources = unmappedStates(id, toTabId);
  let states: Record<string, string> | undefined;
  if (sources.length) {
    const chosen = await ask(sources, visibleStatesOf(toTabId));
    if (!chosen) return null;
    states = chosen;
  }

  // Let queued edits land first. Field writes go through the FIFO outbox; this call does not, so
  // it would otherwise overtake a title the user typed a moment ago — the server would read the
  // pre-edit row, and the DTO we apply below would put the stale title back on screen. Flushing
  // the differ and waiting for the queue costs a beat and keeps what you see accurate.
  flush();
  await drain();
  let result: MoveResult;
  try {
    result = await api.tasks.move(id, toTabId, states);
  } catch (e) {
    // The states changed under us (an admin edited one board, or a sub-task we don't hold): ask
    // again with the server's own lists, keeping what was already chosen.
    if (!(e instanceof ApiError && e.status === 409 && e.data?.error === 'states_unmapped')) throw e;
    const d = e.data as { unmapped: MapSource[]; options: BoardState[] };
    const chosen = await ask(d.unmapped, d.options, states);
    if (!chosen) return null;
    result = await api.tasks.move(id, toTabId, { ...states, ...chosen });
  }
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
