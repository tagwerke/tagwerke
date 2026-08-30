// Lets something outside a board's view put the caret in its quick-add line — the phone's `+`,
// which lives in the bottom nav and has no other way to reach it (NOTES_SPLIT_PLAN §N1).
//
// Only the PRIMARY quick-add on a screen registers (the one carrying the `n` shortcut), so a
// Kanban board's per-column lines can't fight over who receives the focus.

import type { ID } from '../types';

const focusers = new Map<ID, () => void>();

/** Returns its own unregister, for a mount effect's cleanup. */
export function registerQuickAdd(tabId: ID, focus: () => void): () => void {
  focusers.set(tabId, focus);
  return () => {
    if (focusers.get(tabId) === focus) focusers.delete(tabId);
  };
}

/** False when this board has no quick-add mounted — the caller decides what to do instead. */
export function focusQuickAdd(tabId: ID): boolean {
  const focus = focusers.get(tabId);
  if (!focus) return false;
  focus();
  return true;
}
