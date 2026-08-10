// Subscription-based persistence for the two pieces of state that are mutated
// outside the action layer: `tasks` (the editor sync plugins write these directly)
// and each tab's `docJSON` (mutated by setTabDoc, cleanupEmptyTasks).
// On a debounced tick we diff against the last persisted snapshot and emit granular
// upsert/delete/patch calls. Structural entities (projects, tab metadata, blocks,
// snapshots) are persisted explicitly inside their store actions, not here — with one
// carve-out: board and space NAMES, which a user types one character at a time. Sending
// those per keystroke meant a PATCH and an audit row per character, so they are diffed
// here to get this file's coalescing, unload flush and echo suppression for free.

import { useStore } from '../store';
import { api, enqueue } from './client';
import { saveSnapshot } from '../offline/snapshot';
import type { ID, RootState, Task } from '../types';

const DEBOUNCE_MS = 400;

interface Snap {
  tasks: Record<ID, Task>;
  tabNames: Record<ID, string>;
  projectNames: Record<ID, string>;
}

let last: Snap | null = null;
let suspended = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsub: (() => void) | null = null;

function snapshot(s: RootState): Snap {
  // The document no longer persists here — it's a Yjs CRDT synced + saved server-side (see
  // yProvider.ts / server/realtime/ydoc.ts). Only `tasks` and the two name maps are diffed. Doc
  // edits still tick the store subscription, which keeps the offline snapshot fresh at the end
  // of diff().
  return { tasks: s.tasks, tabNames: names(s.tabs), projectNames: names(s.projects) };
}

/** Just the `name` of each entity in a store map — the only field of theirs this file diffs. */
function names(entities: Record<ID, { name: string }>): Record<ID, string> {
  const out: Record<ID, string> = {};
  for (const id in entities) out[id] = entities[id].name;
  return out;
}

/**
 * Emit a PATCH for every renamed entity, and report which ids were NOT sent.
 *
 * A name typed one character at a time passes through "" on the way to the next one, and both
 * PATCH routes require `min(1)` — a rejected write is poison to the outbox, which drops the op
 * and fires a blunt repull, clobbering the edit in progress (that is what made the last letter
 * of a board title undeletable). So a blank name is never sent, and its id comes back here so
 * the caller can hold the field dirty: the real name still goes out on a later tick.
 */
function emitRenames(
  prev: Record<ID, string>,
  next: Record<ID, string>,
  patch: (id: ID, name: string) => void,
): Set<ID> {
  const held = new Set<ID>();
  for (const id in next) {
    // A brand-new entity carries its name in its own create call; only renames belong here.
    if (!(id in prev) || prev[id] === next[id]) continue;
    if (!next[id].trim()) {
      held.add(id);
      continue;
    }
    patch(id, next[id]);
  }
  return held;
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
  rank?: string;
  parentTaskId?: ID | null;
};

function changedFields(p: Task, t: Task): TaskPatch | null {
  const patch: TaskPatch = {};
  if (p.text !== t.text) patch.text = t.text;
  if ((p.status ?? 'todo') !== (t.status ?? 'todo')) patch.status = t.status ?? 'todo';
  if ((p.assigneeId ?? null) !== (t.assigneeId ?? null)) patch.assigneeId = t.assigneeId ?? null;
  if ((p.reviewerId ?? null) !== (t.reviewerId ?? null)) patch.reviewerId = t.reviewerId ?? null;
  if ((p.date ?? null) !== (t.date ?? null)) patch.date = t.date ?? null;
  if ((p.priority ?? null) !== (t.priority ?? null)) patch.priority = t.priority ?? null;
  if ((p.rank ?? null) !== (t.rank ?? null) && t.rank) patch.rank = t.rank;
  if ((p.parentTaskId ?? null) !== (t.parentTaskId ?? null)) patch.parentTaskId = t.parentTaskId ?? null;
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
    ...(t.rank ? { rank: t.rank } : {}),
    parentTaskId: t.parentTaskId ?? null,
    owner: t.owner ?? null,
  };
}

/**
 * Order new-task ids so an ancestor is always emitted before its descendants. The server
 * rejects a `parentTaskId` whose row doesn't exist yet (400 → the outbox drops the op as poison
 * and fires a blunt repull, silently losing the nesting), so a subtree created in one pass must
 * reach it parent-first. Only ids in `creates` constrain the order — a parent that already
 * exists server-side is no constraint at all. Re-entering a node still on the stack is a cycle;
 * we bail rather than hang and let the outer frame emit it (the server rejects cycles anyway).
 */
function topoOrderCreates(creates: ID[], tasks: Record<ID, Task>): ID[] {
  const pending = new Set(creates);
  const emitted = new Set<ID>();
  const visiting = new Set<ID>();
  const out: ID[] = [];
  const visit = (id: ID): void => {
    if (emitted.has(id) || visiting.has(id) || !pending.has(id)) return;
    visiting.add(id);
    const parent = tasks[id]?.parentTaskId;
    if (parent) visit(parent);
    visiting.delete(id);
    emitted.add(id);
    out.push(id);
  };
  for (const id of creates) visit(id);
  return out;
}

function diff(): void {
  if (suspended) return;
  const next = snapshot(useStore.getState());
  if (!last) {
    last = next;
    return;
  }
  const prev = last;

  // Partition before emitting: a create can be the parent of another create, or of an existing
  // task that a patch is re-parenting onto it. Creates go first (ancestors first), then patches,
  // so every parent reference resolves server-side. Within-pass ordering is enough — a parent
  // created in an earlier pass is already ahead of us in the FIFO outbox.
  const creates: ID[] = [];
  const patches: [ID, TaskPatch][] = [];
  for (const id in next.tasks) {
    const t = next.tasks[id];
    const p = prev.tasks[id];
    if (!p || p.homeTabId !== t.homeTabId) {
      // New task, or one that changed home board → full upsert (PATCH carries no homeTabId).
      creates.push(id);
      continue;
    }
    const patch = changedFields(p, t);
    if (patch) patches.push([id, patch]);
  }

  for (const id of topoOrderCreates(creates, next.tasks)) {
    const body = fullBody(next.tasks[id]);
    enqueue(() => api.tasks.upsert(id, body));
  }
  for (const [id, patch] of patches) enqueue(() => api.tasks.patch(id, patch));

  // Deletes cascade to the subtree server-side (SUBTASKS_PLAN D7), so send only the TOPMOST removed
  // task of each removed subtree. Emitting one per descendant would be redundant round trips and,
  // worse, N audit rows for what the user experienced as deleting one thing.
  const removed = new Set<ID>();
  for (const id in prev.tasks) if (!next.tasks[id]) removed.add(id);
  for (const id of removed) {
    const parent = prev.tasks[id]?.parentTaskId;
    if (parent && removed.has(parent)) continue; // covered by an ancestor's delete
    enqueue(() => api.tasks.remove(id));
  }

  // Renames (see emitRenames). A name held back as blank keeps its PREVIOUS value in the new
  // baseline, so the field stays dirty and the eventual real name is still emitted.
  const heldTabs = emitRenames(prev.tabNames, next.tabNames, (id, name) =>
    enqueue(() => api.tabs.update(id, { name })),
  );
  const heldProjects = emitRenames(prev.projectNames, next.projectNames, (id, name) =>
    enqueue(() => api.projects.update(id, { name })),
  );
  for (const id of heldTabs) next.tabNames[id] = prev.tabNames[id];
  for (const id of heldProjects) next.projectNames[id] = prev.projectNames[id];

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

/**
 * Apply a store mutation that has ALREADY happened server-side, without the differ sending it
 * back. Pending local edits are flushed first (so they aren't swallowed), then the baseline is
 * advanced past the applied change so it reads as already-persisted.
 *
 * Used by the realtime layer for a peer's mutation, and by the cross-board move, which applies the
 * rows the server just returned. Both would otherwise be re-emitted as writes and loop.
 */
export function applyServerState(mutate: () => void): void {
  flush();
  suspended = true;
  try {
    mutate();
  } finally {
    setBaseline(useStore.getState());
    suspended = false;
  }
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
