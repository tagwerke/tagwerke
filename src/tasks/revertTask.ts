// Restoring a task to an earlier point in its history.
//
// One server call (POST /api/tasks/:id/revert), nothing applied optimistically — the same shape as
// moveToBoard.ts, for the same reason: the past state is reconstructed from the audit trail, which
// only the server holds, and which of those values today's board will still accept is a question
// this client can't answer. The round trip returns the row that was actually written and we apply
// it verbatim.
//
// The document is untouched. A task's title and metadata live on the entity, not in the doc (D2),
// so a revert changes rows only — peers see it over the entity channel like any other edit.

import { api, drain, type RevertResult } from '../api/client';
import { applyServerState, flush } from '../api/persist';
import { useStore } from '../store';
import { fieldLabel } from '../util/audit';
import type { ID } from '../types';

/** Human-readable summary of a revert, for the drawer. Names what was skipped, and why. */
export function describeRevert(result: RevertResult): string {
  if (!result.restored.length && !result.skipped.length) return 'Already as it was at that point — nothing changed.';
  const parts: string[] = [];
  if (result.restored.length) parts.push(`Restored ${result.restored.map(fieldLabel).join(', ')}`);
  else parts.push('Nothing was restored');
  // Said out loud, per field: a value the server would not write back is a difference between what
  // the user asked for and what they got, and they are the only one who can decide what to do next.
  for (const s of result.skipped) parts.push(`${fieldLabel(s.field)} kept — ${s.reason}`);
  return `${parts.join(' · ')}.`;
}

/**
 * Restore `id` to its state as of history entry `entryId` (inclusive of that entry's own change).
 * Throws on failure (offline, gone entry, or a board the caller may not write) — caller reports it.
 */
export async function revertTaskTo(id: ID, entryId: ID): Promise<RevertResult> {
  // Let queued edits land first — same ordering hazard as a move: this call bypasses the FIFO
  // outbox, so without the flush it could read a row that doesn't yet include the title the user
  // typed a moment ago, and the DTO we apply below would put a stale value back on screen.
  flush();
  await drain();
  const result = await api.tasks.revert(id, entryId);
  applyServerState(() =>
    useStore.setState((s) => (s.tasks[id] ? { tasks: { ...s.tasks, [id]: result.task } } : s)),
  );
  return result;
}
