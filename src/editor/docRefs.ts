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

/** Root task ids in document order — the sequence the board actually reads top to bottom. */
export function rootRefOrder(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'taskItem' && node.attrs.id) ids.push(node.attrs.id as string);
    return true;
  });
  return ids;
}
