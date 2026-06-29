import type { Editor } from '@tiptap/react';
import type { ID } from '../types';
import { useStore } from '../store';
import { taskItemInnerRange } from './taskItemDoc';
import { setTaskTextInDoc, appendTaskToDoc, removeTaskItemsFromDoc, docHasTaskId } from './persistedDoc';

// Registry of mounted editors keyed by tab id, plus the cross-document sync primitives
// for Today ↔ home. The entity (store.tasks) is the hub; each tab's doc is a spoke.
// Edits go through the entity and these helpers fan out text/existence to the other
// spoke(s). Every programmatic write carries `externalEdit` so the sync plugins don't
// re-mirror or echo it.
const editors = new Map<ID, Editor>();

export function registerEditor(tabId: ID, editor: Editor) {
  editors.set(tabId, editor);
}

export function unregisterEditor(tabId: ID, editor: Editor) {
  if (editors.get(tabId) === editor) editors.delete(tabId);
}

export function getEditor(tabId: ID): Editor | undefined {
  return editors.get(tabId);
}

/** Positions of every taskItem in `editor` whose id satisfies `match`. */
function taskPositions(editor: Editor, match: (id: string) => boolean): number[] {
  const out: number[] = [];
  editor.state.doc.descendants((node, p) => {
    if (node.type.name === 'taskItem') {
      const id = node.attrs.id as string | null;
      if (id && match(id)) out.push(p);
    }
    return true;
  });
  return out;
}

/** Set the text of every taskItem with `id` in `editor` (all occurrences). */
function setTextInEditor(editor: Editor, id: ID, text: string): void {
  const positions = taskPositions(editor, (x) => x === id).sort((a, b) => b - a);
  if (!positions.length) return;
  let tr = editor.state.tr;
  for (const pos of positions) {
    const para = editor.state.doc.nodeAt(pos)?.firstChild;
    if (!para) continue;
    const { from, to } = taskItemInnerRange(pos, para);
    tr = tr.replaceWith(from, to, text ? editor.state.schema.text(text) : []);
  }
  editor.view.dispatch(tr.setMeta('externalEdit', true));
}

/**
 * Propagate a task's text to every target doc that references it — a mounted editor
 * (live transaction) or its persisted docJSON. No-op for docs that don't hold the id,
 * so it's safe to call with the union of {home, today}.
 */
export function propagateTaskText(id: ID, text: string, sourceTabId: ID, targetTabIds: ID[]): void {
  const store = useStore.getState();
  for (const tid of targetTabIds) {
    if (!tid || tid === sourceTabId) continue;
    const editor = editors.get(tid);
    if (editor) {
      setTextInEditor(editor, id, text);
    } else {
      const tab = store.tabs[tid];
      if (tab?.docJSON && docHasTaskId(tab.docJSON, id)) {
        store.setTabDoc(tid, setTaskTextInDoc(tab.docJSON, id, text));
      }
    }
  }
}

/** Ensure a taskItem with `id` exists in `tabId`'s doc (mounted or persisted). Idempotent. */
export function ensureTaskInDoc(tabId: ID, id: ID, text: string): void {
  const editor = editors.get(tabId);
  if (editor) {
    if (taskPositions(editor, (x) => x === id).length) return; // already present
    const { state, view, schema } = editor;
    const taskListType = schema.nodes.taskList;
    const taskItemType = schema.nodes.taskItem;
    const paragraphType = schema.nodes.paragraph;
    if (!taskListType || !taskItemType || !paragraphType) return;
    const item = taskItemType.create({ id }, paragraphType.create({}, text ? schema.text(text) : null));
    const list = taskListType.create({}, item);
    view.dispatch(state.tr.insert(state.doc.content.size, list).setMeta('externalEdit', true));
    return;
  }
  const store = useStore.getState();
  const tab = store.tabs[tabId];
  if (!tab) return;
  store.setTabDoc(tabId, appendTaskToDoc(tab.docJSON, id, text));
}

/** Remove task nodes (by id) from the given tabs' docs (mounted or persisted). */
export function removeTasksFromDocs(ids: Set<ID>, tabIds: ID[]): void {
  if (!ids.size) return;
  const store = useStore.getState();
  for (const tid of tabIds) {
    if (!tid) continue;
    const editor = editors.get(tid);
    if (editor) {
      if (!taskPositions(editor, (x) => ids.has(x)).length) continue;
      // Rebuild from JSON minus the nodes — safe against taskList schema (empty-list pruning)
      // without fragile in-place position math. The Today editor isn't focused here.
      const pruned = removeTaskItemsFromDoc(editor.getJSON(), ids);
      editor.commands.setContent(pruned as Parameters<typeof editor.commands.setContent>[0]);
    } else {
      const tab = store.tabs[tid];
      if (tab?.docJSON) store.setTabDoc(tid, removeTaskItemsFromDoc(tab.docJSON, ids));
    }
  }
}
