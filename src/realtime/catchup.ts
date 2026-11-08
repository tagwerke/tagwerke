// Catch-up: keeps an open app current when the realtime socket can't.
//
// The socket (socket.ts) pushes peers' task writes instantly — but only while it is alive, and a
// socket killed by sleep, a backgrounded PWA or a dropped network often dies silently. Leave the
// desktop on, add tasks from the laptop, come back: nothing. Two layers fix that:
//
//   1. Return → full re-pull. Tab becomes visible / window gains focus / network comes back →
//      repull() (throttled). Covers everything: new tasks, deletes, boards shared with you.
//   2. Visible → cheap poll. Every POLL_MS while the page is visible, ask the server for tasks
//      written since our cursor (GET /api/state/changes). Usually empty. Merged with the same
//      rules as a socket frame: an un-acked local write wins, our own edits are never echoed.

import { useStore } from '../store';
import { getTaskChanges } from '../api/client';
import { applyServerState, flush } from '../api/persist';
import { pendingTaskIds } from '../offline/outbox';
import type { ID, Task } from '../types';

const POLL_MS = 5000;
/** A burst of focus/visibility/online events within this window triggers one re-pull. */
const REPULL_THROTTLE_MS = 10_000;

let opts: { repull: () => Promise<void> } | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let lastRepullAt = 0;
/** Newest server `updatedAt` we've merged. null → derive from the store (after boot / a re-pull). */
let cursor: number | null = null;

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function storeCursor(): number {
  let max = 0;
  for (const t of Object.values(useStore.getState().tasks)) if (t.updatedAt && t.updatedAt > max) max = t.updatedAt;
  return max;
}

function onReturn(): void {
  if (!opts || !visible()) return;
  const now = Date.now();
  if (now - lastRepullAt < REPULL_THROTTLE_MS) return;
  lastRepullAt = now;
  void opts.repull().then(() => {
    cursor = null; // the store now holds the authoritative rows → re-derive
  });
}

async function poll(): Promise<void> {
  if (polling || !opts || !visible()) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  polling = true;
  try {
    const since = cursor ?? storeCursor();
    const res = await getTaskChanges(since);
    if (res.more) {
      // Too far behind to page — just take the whole state.
      lastRepullAt = Date.now();
      await opts.repull();
      cursor = null;
      return;
    }
    apply(res.tasks, res.deleted);
    cursor = Math.max(since, res.cursor);
  } catch {
    /* offline / transient — next tick retries */
  } finally {
    polling = false;
  }
}

function apply(rows: Task[], deleted: ID[]): void {
  if (!rows.length && !deleted.length) return;
  flush(); // debounced local edits → outbox first, so pendingTaskIds() sees them
  const pending = pendingTaskIds();
  const have = useStore.getState().tasks;

  // A row we already hold at the same version is the overlap window re-reading — skip it, so an
  // idle poll never touches the store (no re-render, no baseline churn).
  const changed = rows.filter((r) => !pending.has(r.id) && have[r.id]?.updatedAt !== r.updatedAt);
  const gone = deleted.filter((id) => !pending.has(id) && have[id]);
  if (!changed.length && !gone.length) return;

  applyServerState(() => {
    if (changed.length) {
      // Whole-row replace: the DTO is the complete row with absent = cleared, so merging would
      // keep a field a peer just cleared.
      useStore.setState((s) => {
        const tasks = { ...s.tasks };
        for (const r of changed) tasks[r.id] = r;
        return { tasks };
      });
    }
    for (const id of gone) if (useStore.getState().tasks[id]) useStore.getState().deleteTask(id);
  });
}

/** Start catch-up (idempotent). `repull` is the session's full authoritative re-pull. */
export function startCatchup(startOpts: { repull: () => Promise<void> }): void {
  opts = startOpts;
  if (pollTimer) return;
  cursor = null;
  lastRepullAt = Date.now(); // we just booted from a full pull
  pollTimer = setInterval(() => void poll(), POLL_MS);
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  window.addEventListener('online', onReturn);
}

/** Stop catch-up (logout). */
export function stopCatchup(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  opts = null;
  cursor = null;
  document.removeEventListener('visibilitychange', onReturn);
  window.removeEventListener('focus', onReturn);
  window.removeEventListener('online', onReturn);
}
