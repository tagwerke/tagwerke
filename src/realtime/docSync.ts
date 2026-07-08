// Document live-sync + conflict reconcile (C2-doc + C3). The task entity path (C2) lives in
// socket.ts; this module owns the shared document blob, which is the one resource with real
// concurrency (no CRDT in v1 — see internal/planning/CRDT_SEAMS.md).
//
// The editor is the document's authority WHILE MOUNTED: TipTap holds its own content and only
// pushes changes out to the store. So applying a peer's change means pushing it INTO the
// editor (via the registry) — updating only the store is invisible. The invariant that keeps
// saves safe: a board's docVersion advances ONLY together with the editor content changing to
// match it — never from a broadcast alone (which would make the next save write stale editor
// content against a newer version → a silent overwrite).
//
// Responsibilities:
//   1. Track each board's doc version (the base a save is checked against).
//   2. Apply a peer's change live — but only when the user isn't focused in that editor
//      (never yank a live cursor). Otherwise defer until they leave it.
//   3. Reconcile a 409 WITHOUT silent loss: adopt the server document (into the editor) and
//      stash the user's local version for a one-click restore.

import { create } from 'zustand';
import { useStore } from '../store';
import { api } from '../api/client';
import { flush, suspendPersistence, resumePersistence, setBaseline } from '../api/persist';
import { getEditor } from '../editor/registry';
import type { ID } from '../types';

const DEFER_RECHECK_MS = 800; // how often to re-check a deferred board for "left the editor"

// Boards with a newer remote version we deferred because the user was focused in the editor.
const pendingRefresh = new Set<ID>();

/** Surfaced to the UI: unresolved doc conflicts (server adopted, local stashed for restore). */
interface Conflict {
  boardId: ID;
  localDoc: unknown;
}
interface ConflictStore {
  conflicts: Record<ID, Conflict>;
  set(c: Conflict): void;
  clear(id: ID): void;
}
export const useDocConflicts = create<ConflictStore>((set) => ({
  conflicts: {},
  set: (c) => set((s) => ({ conflicts: { ...s.conflicts, [c.boardId]: c } })),
  clear: (id) => set((s) => { const n = { ...s.conflicts }; delete n[id]; return { conflicts: n }; }),
}));

// --- version tracking ------------------------------------------------------------------

function currentVersion(id: ID): number {
  return useStore.getState().tabs[id]?.docVersion ?? 0;
}

/** Advance a board's stored doc version (from a save response) without touching docJSON, so
 *  the persist differ doesn't treat it as a document edit. Safe because our just-saved content
 *  IS this new version — the editor already matches. */
export function setDocVersion(id: ID, version: number): void {
  const tab = useStore.getState().tabs[id];
  if (!tab || tab.docVersion === version) return;
  useStore.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], docVersion: version } } }));
}

/** The version a save should declare as its base = the version the editor content matches. */
export function baseVersionFor(id: ID): number {
  return currentVersion(id);
}

/** The user is "in" a board's document when its editor is mounted and focused. */
function isEditorBusy(id: ID): boolean {
  const ed = getEditor(id);
  return !!ed && ed.isFocused;
}

// --- applying a document (into store AND editor), echo-free ----------------------------

/**
 * Replace a board's document + version everywhere — the store AND the mounted editor — without
 * it echoing back to the server. Pushing into the editor is what makes the change visible;
 * updating the store keeps a remount correct. emitUpdate:false so setContent doesn't fire the
 * editor's onUpdate (which would re-save it).
 */
function adoptDoc(id: ID, docJSON: unknown, version: number): void {
  flush(); // persist any pending local edits BEFORE moving the baseline
  suspendPersistence();
  try {
    useStore.setState((s) => (s.tabs[id] ? { tabs: { ...s.tabs, [id]: { ...s.tabs[id], docJSON, docVersion: version } } } : s));
    const ed = getEditor(id);
    if (ed && docJSON) ed.commands.setContent(docJSON as Record<string, unknown>, { emitUpdate: false });
  } finally {
    setBaseline(useStore.getState());
    resumePersistence();
  }
}

// --- C2: apply a peer's document change ------------------------------------------------

/**
 * Handle a 'doc' invalidation for a board. Newer than us and the user isn't focused in that
 * editor → pull the fresh document and apply it live. If they're focused (typing), defer —
 * do NOT advance the version — and apply once they leave; a save they make meanwhile hits the
 * 409 reconcile instead.
 */
export async function onDocInvalidation(id: ID, version: number): Promise<void> {
  if (version <= currentVersion(id)) return; // our own echo, or already ahead
  if (isEditorBusy(id)) {
    pendingRefresh.add(id);
    scheduleDeferredCheck();
    return;
  }
  await pullAndApply(id);
}

async function pullAndApply(id: ID): Promise<void> {
  try {
    const { docJSON, docVersion } = await api.tabs.fetchDoc(id);
    if (docVersion > currentVersion(id)) adoptDoc(id, docJSON, docVersion);
  } catch {
    /* offline/transient — a reconnect resync will catch it */
  }
}

let deferredTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDeferredCheck(): void {
  if (deferredTimer) return;
  deferredTimer = setTimeout(() => {
    deferredTimer = null;
    for (const id of [...pendingRefresh]) {
      if (isEditorBusy(id)) continue; // still in the editor — keep waiting
      pendingRefresh.delete(id);
      void pullAndApply(id);
    }
    if (pendingRefresh.size) scheduleDeferredCheck();
  }, DEFER_RECHECK_MS);
}

// --- C3: reconcile a stale-save 409 ----------------------------------------------------

/**
 * The doc save's onConflict. The server rejected our save (someone saved in between) and
 * returned its current { currentVersion, docJSON }. We adopt the server document as truth
 * (into the editor) AND stash the user's local version so nothing is lost — the UI offers a
 * restore. No blind overwrite (which would lose the peer's edit) and no retry loop.
 */
export function reconcileDocConflict(id: ID, res: unknown): void {
  const body = res as { currentVersion?: number; docJSON?: unknown } | undefined;
  if (!body || typeof body.currentVersion !== 'number') return;
  const localDoc = useStore.getState().tabs[id]?.docJSON;
  useDocConflicts.getState().set({ boardId: id, localDoc });
  adoptDoc(id, body.docJSON ?? null, body.currentVersion);
}

/** Restore the stashed local version (user chose "keep mine"): put it back into the editor and
 *  store so the persist differ re-saves it on the now-current base (local wins). Uses a plain
 *  editor setContent WITH emitUpdate so onUpdate → setTabDoc drives the save. */
export function restoreLocalDoc(id: ID): void {
  const conflict = useDocConflicts.getState().conflicts[id];
  if (!conflict) return;
  useDocConflicts.getState().clear(id);
  const ed = getEditor(id);
  if (ed && conflict.localDoc) {
    ed.commands.setContent(conflict.localDoc as Record<string, unknown>, { emitUpdate: true });
  } else {
    // Editor not mounted — write the store directly; it saves on the next differ tick.
    useStore.setState((s) => (s.tabs[id] ? { tabs: { ...s.tabs, [id]: { ...s.tabs[id], docJSON: conflict.localDoc } } } : s));
  }
}

/** Discard the stash (user chose "keep theirs"). */
export function dismissDocConflict(id: ID): void {
  useDocConflicts.getState().clear(id);
}
