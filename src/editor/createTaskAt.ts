// Shared "replace this paragraph with a one-item task list" transaction — the mechanical part both
// the "- " input rule (TaskList.ts) and the empty-line "+" button (extensions/EmptyLineAdd.ts) do,
// kept as one function so both paths produce byte-identical documents. Deliberately does NOT
// require the paragraph to be empty: the input rule fires the instant the paragraph's text matches
// "- " (so it's never empty — content.size is 2 — at the exact moment it needs replacing). Emptiness
// is each caller's OWN precondition to check, appropriate to its own context, not this function's.

import { nanoid } from 'nanoid';
import type { EditorView } from '@tiptap/pm/view';
import { requestTaskFocus } from './taskFocus';
import { getEditor } from './registry';
import type { ID } from '../types';

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

/**
 * Add a task at the END of a board's document, from outside the editor.
 *
 * The third way in, after the "- " input rule and the empty-line "+". It exists because a phone has
 * no left gutter, so the "+" is not offered there (index.css, phone breakpoint) — which would
 * otherwise leave the typed "- " gesture as the only way to make a task on a phone, and that gesture
 * is precisely what the "+" was written to spare people. The bottom nav calls this instead.
 *
 * Reaches the editor through the registry, which has been waiting for a caller like this one. Both
 * the reuse and the insert branch end at `createTaskAtParagraph`, so a task made from the nav is
 * byte-identical to one made any other way.
 *
 * Returns false — and changes nothing — when the board has no mounted editor (a non-doc view) or
 * the caller may not edit it. The caller decides what to do instead; this never guesses.
 */
export function appendTaskToBoard(tabId: ID): boolean {
  const view = getEditor(tabId)?.view;
  if (!view || !view.editable) return false;
  const { doc } = view.state;
  const last = doc.lastChild;
  // A trailing empty paragraph is the usual state of a document someone has been typing in — use
  // it rather than leaving a blank line stranded above the new task.
  if (last && last.type.name === 'paragraph' && last.content.size === 0) {
    return createTaskAtParagraph(view, doc.content.size - 1);
  }
  const paragraph = view.state.schema.nodes.paragraph;
  if (!paragraph) return false;
  view.dispatch(view.state.tr.insert(doc.content.size, paragraph.create()));
  // Re-read: the position below is into the paragraph the dispatch above just created.
  return createTaskAtParagraph(view, view.state.doc.content.size - 1);
}
