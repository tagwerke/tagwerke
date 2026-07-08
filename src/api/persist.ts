// Subscription-based persistence for the two pieces of state that are mutated
// outside the action layer: `tasks` (the editor sync plugins write these directly)
// and each tab's `docJSON` (mutated by setTabDoc, cleanupEmptyTasks).
// On a debounced tick we diff against the last persisted snapshot and emit granular
// upsert/delete/patch calls. Structural entities (projects, tab metadata, blocks,
// snapshots) are persisted explicitly inside their store actions, not here.

import { useStore } from '../store';
import { api, enqueue } from './client';
import { saveSnapshot } from '../offline/snapshot';
import { baseVersionFor, setDocVersion, reconcileDocConflict } from '../realtime/docSync';
import type { ID, RootState, Task } from '../types';

const DEBOUNCE_MS = 400;

interface Snap {
  tasks: Record<ID, Task>;
  docs: Record<ID, unknown>;
}

let last: Snap | null = null;
let suspended = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsub: (() => void) | null = null;

function snapshot(s: RootState): Snap {
  const docs: Record<ID, unknown> = {};
  for (const id in s.tabs) docs[id] = s.tabs[id].docJSON;
  return { tasks: s.tasks, docs };
}

// Field-granular diff (SPEC §8): only changed fields are sent, so a text edit can't
// clobber a concurrently-set status/assignee. `done`/`owner` are no longer client-edited.
type TaskPatch = {
  text?: string;
  status?: Task['status'];
  assigneeId?: ID | null;
  reviewerId?: ID | null;
  date?: string | null;
  priority?: 1 | 2 | 3 | null;
  position?: number;
};

function changedFields(p: Task, t: Task): TaskPatch | null {
  const patch: TaskPatch = {};
  if (p.text !== t.text) patch.text = t.text;
  if ((p.status ?? 'todo') !== (t.status ?? 'todo')) patch.status = t.status ?? 'todo';
  if ((p.assigneeId ?? null) !== (t.assigneeId ?? null)) patch.assigneeId = t.assigneeId ?? null;
  if ((p.reviewerId ?? null) !== (t.reviewerId ?? null)) patch.reviewerId = t.reviewerId ?? null;
  if ((p.date ?? null) !== (t.date ?? null)) patch.date = t.date ?? null;
  if ((p.priority ?? null) !== (t.priority ?? null)) patch.priority = t.priority ?? null;
  if ((p.position ?? 0) !== (t.position ?? 0)) patch.position = t.position ?? 0;
  // approvedBy/approvedAt are DB-managed (set on the in_review → done transition) and never
  // sent from the client.
  return Object.keys(patch).length ? patch : null;
}

function fullBody(t: Task) {
  return {
    homeTabId: t.homeTabId,
    text: t.text,
    status: t.status ?? 'todo',
    assigneeId: t.assigneeId ?? null,
    reviewerId: t.reviewerId ?? null,
    date: t.date ?? null,
    priority: t.priority ?? null,
    position: t.position ?? 0,
    owner: t.owner ?? null,
  };
}

function diff(): void {
  if (suspended) return;
  const next = snapshot(useStore.getState());
  if (!last) {
    last = next;
    return;
  }
  const prev = last;

  for (const id in next.tasks) {
    const t = next.tasks[id];
    const p = prev.tasks[id];
    if (!p || p.homeTabId !== t.homeTabId) {
      // New task, or one that changed home board → full upsert (PATCH carries no homeTabId).
      enqueue(() => api.tasks.upsert(id, fullBody(t)));
      continue;
    }
    const patch = changedFields(p, t);
    if (patch) enqueue(() => api.tasks.patch(id, patch));
  }
  for (const id in prev.tasks) {
    if (!next.tasks[id]) enqueue(() => api.tasks.remove(id));
  }

  for (const id in next.docs) {
    // Brand-new tabs are created via the createTab action; their first doc edit is
    // caught on the following diff once the tab exists in `prev`.
    if (!(id in prev.docs)) continue;
    const doc = next.docs[id];
    if (doc !== prev.docs[id] && doc != null) {
      // Optimistic-concurrency doc save: declare the base version, capture the advanced
      // version on success, and reconcile a 409 doc-locally (adopt server + stash local)
      // instead of the blunt full repull. See src/realtime/docSync.ts.
      const baseVersion = baseVersionFor(id);
      enqueue(() =>
        api.tabs.saveDoc(id, doc, baseVersion, {
          onOk: (res) => {
            const v = (res as { docVersion?: number } | undefined)?.docVersion;
            if (typeof v === 'number') setDocVersion(id, v);
          },
          onConflict: (res) => reconcileDocConflict(id, res),
        }),
      );
    }
  }

  last = next;
  // Keep the offline snapshot current so a reload (online or not) restores edits.
  saveSnapshot(useStore.getState());
}

function schedule(): void {
  if (suspended) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    diff();
  }, DEBOUNCE_MS);
}

/** Reset the diff baseline to the given state without emitting any writes (after hydrate). */
export function setBaseline(s: RootState): void {
  last = snapshot(s);
}

/** Run the diff immediately (e.g. before unload) instead of waiting for the debounce. */
export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  diff();
}

export function startPersistence(): void {
  if (unsub) return;
  setBaseline(useStore.getState());
  unsub = useStore.subscribe(schedule);
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

export function suspendPersistence(): void {
  suspended = true;
}

export function resumePersistence(): void {
  suspended = false;
}
