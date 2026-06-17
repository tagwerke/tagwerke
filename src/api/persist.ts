// Subscription-based persistence for the two pieces of state that are mutated
// outside the action layer: `tasks` (the editor sync plugins write these directly)
// and each tab's `docJSON` (mutated by setTabDoc, cleanupEmptyTasks, freezeToday).
// On a debounced tick we diff against the last persisted snapshot and emit granular
// upsert/delete/patch calls. Structural entities (projects, tab metadata, blocks,
// snapshots) are persisted explicitly inside their store actions, not here.

import { useStore } from '../store';
import { api, enqueue } from './client';
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

function taskChanged(a: Task, b: Task): boolean {
  return (
    a.text !== b.text ||
    a.done !== b.done ||
    a.date !== b.date ||
    a.priority !== b.priority ||
    a.owner !== b.owner ||
    a.homeTabId !== b.homeTabId
  );
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
    if (!p || taskChanged(p, t)) {
      enqueue(() =>
        api.tasks.upsert(id, {
          homeTabId: t.homeTabId,
          text: t.text,
          date: t.date ?? null,
          priority: t.priority ?? null,
          owner: t.owner ?? null,
          done: t.done ?? false,
        }),
      );
    }
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
      enqueue(() => api.tabs.update(id, { docJSON: doc }));
    }
  }

  last = next;
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
