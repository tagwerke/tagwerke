// Arrow-key movement between task rows in the document (SUBTASKS_PLAN P4).
//
// Rendered DOM order IS outline order — a root's node view renders its whole subtree inline — so
// moving between two rows of the SAME tree is a plain walk of the rendered rows. The one thing DOM
// order gets wrong is PROSE: two roots may have a paragraph between them, and a widget-to-widget
// jump would silently skip it. So crossing a root boundary hands off to the document, resolving a
// real ProseMirror position and letting the caret land in the prose when that is what comes next.
//
// That split is the whole design: fast structural movement inside a subtree, document-aware
// movement between them. Tree membership is read off the DOM (`[data-root-id]` wraps a root and
// everything under it), which is both cheaper and more truthful than re-deriving it from the store
// — it answers "what is actually on screen", which is what arrow keys move through.

import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { focusTaskWidget } from './taskFocus';
import { findRefPos } from './docRefs';
import type { ID } from '../types';

function esc(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

function rowEl(dom: HTMLElement, id: ID): HTMLElement | null {
  return dom.querySelector(`li[data-type="taskItem"][data-id="${esc(id)}"]`);
}

/** The id of the ROOT whose tree contains the rendered row `id` (itself, when it is a root). */
function renderedRootOf(dom: HTMLElement, id: ID): ID | null {
  return rowEl(dom, id)?.closest('[data-root-id]')?.getAttribute('data-root-id') ?? null;
}

/**
 * The LAST rendered row of `rootId`'s tree. Moving UP into a tree should land on its deepest final
 * sub-task, not leap over the whole subtree to the root's own title.
 */
export function lastRenderedOf(dom: HTMLElement, rootId: ID): ID {
  const root = dom.querySelector(`[data-root-id="${esc(rootId)}"]`);
  if (!root) return rootId;
  const rows = root.querySelectorAll('li[data-type="taskItem"]');
  return rows[rows.length - 1]?.getAttribute('data-id') ?? rootId;
}

/** Task ids in rendered order — equal to outline order. */
function renderedIds(dom: HTMLElement): string[] {
  return Array.from(dom.querySelectorAll('li[data-type="taskItem"]'))
    .map((el) => el.getAttribute('data-id'))
    .filter((id): id is string => !!id);
}

/**
 * Move to the block adjacent to this task in reading order: the neighbouring row when it belongs to
 * the same tree, otherwise whatever the DOCUMENT says comes next — an adjacent task tree, or a
 * paragraph, in which case the caret goes back to ProseMirror.
 */
export function navFromTaskLine(editor: Editor, id: ID, dir: 'up' | 'down'): void {
  const dom = editor.view.dom as HTMLElement;
  const ids = renderedIds(dom);
  const idx = ids.indexOf(id);
  const neighbour = idx < 0 ? undefined : ids[idx + (dir === 'up' ? -1 : 1)];
  const myRoot = renderedRootOf(dom, id);

  // Within one tree there can be no prose, so the rendered neighbour is unambiguously correct.
  if (neighbour && myRoot && renderedRootOf(dom, neighbour) === myRoot) {
    focusTaskWidget(dom, neighbour, dir === 'up' ? 'end' : 'start');
    return;
  }

  // Crossing a root boundary: ask the document, so prose between the two roots isn't skipped.
  const pos = myRoot ? findRefPos(editor, myRoot) : null;
  if (pos == null) {
    if (neighbour) focusTaskWidget(dom, neighbour, dir === 'up' ? 'end' : 'start');
    return;
  }
  navFromRootRef(editor, pos, dir);
}

/**
 * Document-aware step out of the root ref at `pos`: a sibling root in the same list, the edge root
 * of an adjacent list, or an adjacent prose block.
 */
function navFromRootRef(editor: Editor, pos: number, dir: 'up' | 'down'): void {
  const { doc } = editor.state;
  const dom = editor.view.dom as HTMLElement;
  let taskList: PMNode | null = null;
  let listStart = 0;
  let topIdx = -1;
  doc.forEach((child, offset, index) => {
    if (offset <= pos && pos < offset + child.nodeSize) {
      taskList = child;
      listStart = offset;
      topIdx = index;
    }
  });
  const list = taskList as PMNode | null;
  if (!list || list.type.name !== 'taskList') return;

  let idx = -1;
  list.forEach((_item, offset, index) => {
    if (listStart + 1 + offset === pos) idx = index;
  });

  const focusTree = (item: PMNode | null | undefined, where: 'start' | 'end') => {
    const rootId = item?.attrs?.id as string | undefined;
    if (!rootId) return;
    // Entering from below lands on the tree's last row; from above, on its title.
    focusTaskWidget(dom, where === 'end' ? lastRenderedOf(dom, rootId) : rootId, where);
  };

  if (dir === 'up' && idx > 0) return focusTree(list.child(idx - 1), 'end');
  if (dir === 'down' && idx >= 0 && idx < list.childCount - 1) return focusTree(list.child(idx + 1), 'start');

  const sib = dir === 'up' ? doc.maybeChild(topIdx - 1) : doc.maybeChild(topIdx + 1);
  if (!sib) return; // nothing beyond the list in this direction
  if (sib.type.name === 'taskList') {
    return focusTree(dir === 'up' ? sib.child(sib.childCount - 1) : sib.child(0), dir === 'up' ? 'end' : 'start');
  }
  // Adjacent prose block → place the PM caret in it and hand focus back to ProseMirror.
  const at = dir === 'up' ? listStart : listStart + list.nodeSize;
  const sel = TextSelection.near(doc.resolve(at), dir === 'up' ? -1 : 1);
  editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
  editor.view.focus();
}
