// Structural task operations — Enter / Tab / Shift-Tab / Backspace, expressed once and shared by
// the root node view and the plain child rows it renders (SUBTASKS_PLAN P4).
//
// Every operation writes the ROW (parent + rank, which own the tree) and touches the DOCUMENT only
// at the two boundaries where a task's root-ness changes: Tab on a root removes its ref, and
// Shift-Tab out of the last level of nesting adds one back. See docRefs.ts.

import { nanoid } from 'nanoid';
import type { Editor } from '@tiptap/react';
import { childrenOf, siblingsOf, taskDepth, useStore } from '../store';
import { rankBetween } from '../../shared/rank';
import { MAX_TASK_DEPTH } from '../../shared/tree';
import { insertRefAfter, removeRef } from './docRefs';
import { requestTaskFocus } from './taskFocus';
import type { ID, Task } from '../types';

/** How many levels sit below `id` (0 for a leaf). Bounded, so a corrupt cycle can't spin. */
export function subtreeHeight(tasks: Record<ID, Task>, id: ID, depth = 0): number {
  if (depth > MAX_TASK_DEPTH + 1) return 0;
  const kids = childrenOf(tasks, id);
  if (!kids.length) return 0;
  return 1 + Math.max(...kids.map((k) => subtreeHeight(tasks, k.id, depth + 1)));
}

/** The task that would become the new parent if `id` were nested: its previous sibling, or null. */
export function nestTargetFor(tasks: Record<ID, Task>, id: ID): Task | null {
  const task = tasks[id];
  if (!task) return null;
  const sibs = siblingsOf(tasks, task.homeTabId, task.parentTaskId);
  const idx = sibs.findIndex((s) => s.id === id);
  return idx > 0 ? sibs[idx - 1] : null;
}

/** True when Tab on `id` would do something legal — the key is a no-op otherwise, never a failed
 *  round trip. Mirrors the server's parentRefusal so the two agree on the limit. */
export function canNest(tasks: Record<ID, Task>, id: ID): boolean {
  const target = nestTargetFor(tasks, id);
  if (!target) return false;
  return taskDepth(tasks, target.id) + 1 + subtreeHeight(tasks, id) <= MAX_TASK_DEPTH;
}

/** Create an empty task directly after `id`, as its sibling, and put the caret in it. */
export function createSiblingAfter(editor: Editor, id: ID, fallbackTabId: ID): void {
  const store = useStore.getState();
  const task = store.tasks[id];
  const homeTabId = task?.homeTabId ?? fallbackTabId;
  const parentTaskId = task?.parentTaskId;

  // Slot the new task between this one and the next sibling, so it appears exactly where the caret
  // was rather than at the end of the list.
  const sibs = siblingsOf(store.tasks, homeTabId, parentTaskId);
  const idx = sibs.findIndex((s) => s.id === id);
  const next = idx >= 0 ? sibs[idx + 1] : undefined;
  let rank: string | undefined;
  try {
    rank = rankBetween(task?.rank ?? null, next?.rank ?? null);
  } catch {
    rank = undefined; // unranked neighbours → let the store append
  }

  const newId = `t_${nanoid(8)}`;
  store.upsertTask({ id: newId, homeTabId, text: '', parentTaskId, rank });
  requestTaskFocus(newId);
  // Only a root occupies a slot in the document; a child is rendered by its root's node view.
  if (!parentTaskId) insertRefAfter(editor, id, newId);
}

/** Tab: nest under the previous sibling. Removes the document ref if the task was a root. */
export function nestTask(editor: Editor, id: ID): void {
  const store = useStore.getState();
  const task = store.tasks[id];
  if (!task) return;
  if (!canNest(store.tasks, id)) return;
  const target = nestTargetFor(store.tasks, id);
  if (!target) return;

  const wasRoot = !task.parentTaskId;
  store.setTaskParent(id, target.id); // appends under the new parent
  if (wasRoot) removeRef(editor, id); // it is no longer a root, so it no longer has a slot
  requestTaskFocus(id);
}

/** Shift-Tab: lift one level. Adds a document ref back when the task returns to the top level. */
export function unnestTask(editor: Editor, id: ID): void {
  const store = useStore.getState();
  const task = store.tasks[id];
  const parentId = task?.parentTaskId;
  if (!task || !parentId) return; // already a root
  const parent = store.tasks[parentId];
  const grandparentId = parent?.parentTaskId;

  // Land immediately after the old parent among its own siblings — the position the eye expects
  // after out-denting, rather than the end of the grandparent's children.
  let rank: string | undefined;
  if (parent) {
    const sibs = siblingsOf(store.tasks, parent.homeTabId, grandparentId);
    const idx = sibs.findIndex((s) => s.id === parentId);
    const next = idx >= 0 ? sibs[idx + 1] : undefined;
    try {
      rank = rankBetween(parent.rank ?? null, next?.rank ?? null);
    } catch {
      rank = undefined;
    }
  }

  store.setTaskParent(id, grandparentId, rank);
  // Back at the top level → it needs its own slot in the prose, right after its former parent.
  if (!grandparentId) insertRefAfter(editor, parentId, id);
  requestTaskFocus(id);
}

/** Backspace on an empty title: remove the task (and its subtree), plus its ref when it was a root. */
export function deleteTaskLine(editor: Editor, id: ID): void {
  const store = useStore.getState();
  const task = store.tasks[id];
  if (!task) return;
  if (!task.parentTaskId) removeRef(editor, id);
  store.deleteTask(id); // cascades to descendants locally; the server does the same
}
