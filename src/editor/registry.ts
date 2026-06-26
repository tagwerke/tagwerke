import type { Editor } from '@tiptap/react';
import type { ID } from '../types';
import { taskItemInnerRange } from './taskItemDoc';

const editors = new Map<ID, Editor>();

/** Find the first mounted editor holding a taskItem with this id, and its position. */
function findTaskItem(taskId: ID): { editor: Editor; pos: number } | null {
  for (const editor of editors.values()) {
    let pos: number | null = null;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === 'taskItem' && node.attrs.id === taskId) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos != null) return { editor, pos };
  }
  return null;
}

export function registerEditor(tabId: ID, editor: Editor) {
  editors.set(tabId, editor);
}

export function unregisterEditor(tabId: ID, editor: Editor) {
  if (editors.get(tabId) === editor) editors.delete(tabId);
}

export function getEditor(tabId: ID): Editor | undefined {
  return editors.get(tabId);
}

/**
 * Update the text of a taskItem inside the home tab's doc.
 * Returns true if the node was found and updated. If the editor is not mounted,
 * caller should fall back to applying the change to the persisted doc JSON.
 */
export function applyTaskTextEditToHome(taskId: ID, newText: string): boolean {
  const hit = findTaskItem(taskId);
  if (!hit) return false;
  const { editor, pos } = hit;
  const { state, view } = editor;
  const para = state.doc.nodeAt(pos)!.firstChild;
  if (!para) return false;
  const { from, to } = taskItemInnerRange(pos, para);
  const tr = state.tr.replaceWith(from, to, newText ? state.schema.text(newText) : []);
  view.dispatch(tr.setMeta('externalEdit', true));
  return true;
}

/** Insert a new task line at the end of a home tab's doc, return its id. */
export function appendNewTaskToHome(tabId: ID, text: string): string | null {
  const editor = editors.get(tabId);
  if (!editor) return null;
  const { state, view, schema } = editor;
  const id = `t_${Math.random().toString(36).slice(2, 10)}`;
  const taskListType = schema.nodes.taskList;
  const taskItemType = schema.nodes.taskItem;
  const paragraphType = schema.nodes.paragraph;
  if (!taskListType || !taskItemType) return null;
  const item = taskItemType.create(
    { id },
    paragraphType.create({}, text ? schema.text(text) : null)
  );
  const list = taskListType.create({}, item);

  const tr = state.tr.insert(state.doc.content.size, list);
  view.dispatch(tr.setMeta('externalEdit', true));
  return id;
}
