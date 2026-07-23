// Shared "replace this paragraph with a one-item task list" transaction — the mechanical part both
// the "- " input rule (TaskList.ts) and the empty-line "+" button (extensions/EmptyLineAdd.ts) do,
// kept as one function so both paths produce byte-identical documents. Deliberately does NOT
// require the paragraph to be empty: the input rule fires the instant the paragraph's text matches
// "- " (so it's never empty — content.size is 2 — at the exact moment it needs replacing). Emptiness
// is each caller's OWN precondition to check, appropriate to its own context, not this function's.

import { nanoid } from 'nanoid';
import type { EditorView } from '@tiptap/pm/view';
import { requestTaskFocus } from './taskFocus';

/** `pos` must resolve inside a paragraph (any content — the whole paragraph is replaced). No-ops
 *  (returns false) otherwise, or if the view isn't editable (a viewer's read-only doc). */
export function createTaskAtParagraph(view: EditorView, pos: number): boolean {
  // The input rule only ever fires from a real keystroke, which a non-editable DOM already blocks
  // — but the "+" button is a programmatic click that bypasses that gate entirely, so a viewer
  // clicking it needs an explicit check here (shared, so both callers stay covered).
  if (!view.editable) return false;
  const { state } = view;
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.name !== 'paragraph') return false;
  const taskItem = state.schema.nodes.taskItem;
  const listType = state.schema.nodes.taskList;
  if (!taskItem || !listType) return false;

  const id = `t_${nanoid(8)}`;
  const paraStart = $pos.before();
  const paraEnd = paraStart + $pos.parent.nodeSize;
  requestTaskFocus(id);
  view.dispatch(state.tr.replaceWith(paraStart, paraEnd, listType.create(null, taskItem.create({ id }))));
  return true;
}
