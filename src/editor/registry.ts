import type { Editor } from '@tiptap/react';
import type { ID } from '../types';

// Registry of mounted editors keyed by tab id. With tasks as first-class shared
// entities (status/text/etc. live on store.tasks, which every view subscribes to),
// there is no cross-document sync to perform — this is just a lookup so future
// features (e.g. focus/scroll-to, collaborative cursors) can reach a tab's editor.
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
