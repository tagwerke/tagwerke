// Document-side operations on task REFS (SUBTASKS_PLAN D2).
//
// Since the subtasks migration the document holds a ref for ROOT tasks only — a `taskItem` atom
// means "the task tree rooted at this id appears here in the prose". Children have no node at all;
// their root's node view renders them from the store.
//
// That makes nesting and un-nesting document edits again, not pure field writes:
//   Tab on a root       → it stops being a root, so its ref must LEAVE the document
//   Shift-Tab to depth 0 → it becomes a root, so a ref must ENTER the document
// Everything in between (nesting a child under a different child) touches no document at all.
//
// These helpers are the only place that knows how a ref is spelled, so the node view and the plain
// child rows can share one set of operations.

import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

/** Document position of the ref atom for `id`, or null when the task has no ref (i.e. it is not a root). */
export function findRefPos(editor: Editor, id: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'taskItem' && node.attrs.id === id) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** Delete the ref at `pos`, taking the enclosing taskList with it when that empties the list. */
function deleteRefAt(tr: Transaction, doc: PMNode, pos: number): Transaction {
  const node = doc.nodeAt(pos);
  if (!node) return tr;
  const $pos = doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  if ($pos.parent.type.name === 'taskList' && $pos.parent.childCount === 1) {
    from = $pos.before();
    to = from + $pos.parent.nodeSize;
  }
  return tr.delete(from, to);
}

/** Remove a task's ref from the document. No-op when it has none. Returns true if anything changed. */
export function removeRef(editor: Editor, id: string): boolean {
  const pos = findRefPos(editor, id);
  if (pos == null) return false;
  editor.view.dispatch(deleteRefAt(editor.state.tr, editor.state.doc, pos));
  return true;
}

/**
 * Insert a ref for `id` immediately after the ref for `afterId`, joining the same taskList so the
 * two read as one run of tasks. Falls back to appending a fresh list at the end of the document
 * when `afterId` has no ref (it wasn't a root either) — a task must always be reachable.
 */
export function insertRefAfter(editor: Editor, afterId: string | null, id: string): void {
  const { state } = editor;
  const taskItem = state.schema.nodes.taskItem;
  const taskList = state.schema.nodes.taskList;
  if (!taskItem || !taskList) return;

  const afterPos = afterId ? findRefPos(editor, afterId) : null;
  if (afterPos != null) {
    const node = state.doc.nodeAt(afterPos);
    if (node) {
      editor.view.dispatch(state.tr.insert(afterPos + node.nodeSize, taskItem.create({ id })));
      return;
    }
  }
  editor.view.dispatch(state.tr.insert(state.doc.content.size, taskList.create(null, taskItem.create({ id }))));
}

/** Insert a ref for `id` immediately BEFORE the ref for `beforeId`, or append when there is none. */
export function insertRefBefore(editor: Editor, beforeId: string | null, id: string): void {
  const { state } = editor;
  const taskItem = state.schema.nodes.taskItem;
  const taskList = state.schema.nodes.taskList;
  if (!taskItem || !taskList) return;

  const beforePos = beforeId ? findRefPos(editor, beforeId) : null;
  if (beforePos != null) {
    editor.view.dispatch(state.tr.insert(beforePos, taskItem.create({ id })));
    return;
  }
  editor.view.dispatch(state.tr.insert(state.doc.content.size, taskList.create(null, taskItem.create({ id }))));
}

/** Every root ref with its document position, in document order — the sequence the board reads top
 *  to bottom. Used to work out which roots a drop lands between, so the rank written to the rows
 *  agrees with the order the prose shows. */
export function refPositions(editor: Editor): { id: string; pos: number }[] {
  const out: { id: string; pos: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && node.attrs.id) out.push({ id: node.attrs.id as string, pos });
    return true;
  });
  return out;
}

/**
 * Put `id`'s ref at document position `pos`, in ONE transaction — moving the existing ref if the
 * task had one (a root being repositioned) and creating it if it didn't (a sub-task being promoted
 * into the prose).
 *
 * One transaction because the two halves interact: deleting the old ref shifts everything after it,
 * so the insertion point is mapped through that deletion rather than recomputed. Doing it as two
 * dispatches would also flash a moment where the task has no ref at all, which the GC in SyncPlugin
 * reads as "deleted".
 *
 * A taskItem cannot stand on its own — the schema says it lives in a taskList — so the insert
 * joins an adjacent list when there is one and wraps a fresh list around it when there isn't.
 * Joining matters: dropping a task directly under an existing list should extend that list, not
 * leave two lists sitting next to each other with a seam between them.
 */
export function placeRefAt(editor: Editor, id: string, pos: number): void {
  const { state } = editor;
  const taskItem = state.schema.nodes.taskItem;
  const taskList = state.schema.nodes.taskList;
  if (!taskItem || !taskList) return;

  const tr = state.tr;
  const existing = findRefPos(editor, id);
  if (existing != null) deleteRefAt(tr, state.doc, existing);

  // Map through the deletion (a no-op when there was nothing to delete), then read the neighbours
  // off the POST-deletion doc — the list the ref just left may no longer exist.
  const at = Math.min(tr.mapping.map(pos), tr.doc.content.size);
  const $at = tr.doc.resolve(at);
  const before = $at.nodeBefore;
  const after = $at.nodeAfter;

  if (before?.type.name === 'taskList') {
    tr.insert(at - 1, taskItem.create({ id })); // just inside the end of the list above
  } else if (after?.type.name === 'taskList') {
    tr.insert(at + 1, taskItem.create({ id })); // just inside the start of the list below
  } else {
    tr.insert(at, taskList.create(null, taskItem.create({ id })));
  }
  editor.view.dispatch(tr);
}
