import { Node, mergeAttributes } from '@tiptap/core';

// TASKS_AS_ENTITIES.md P2: a taskItem is now an id-only REFERENCE (a leaf atom). The task's text
// and metadata live on the entity (store.tasks), NOT in the document. TaskItemView renders the
// title as a widget bound to the row; keyboard behaviour lives there (the node carries no editable
// content). `tabId` is threaded through options so the node view can home newly-created siblings.
export interface TaskItemOptions {
  HTMLAttributes: Record<string, unknown>;
  tabId: string;
}

export const TaskItem = Node.create<TaskItemOptions>({
  name: 'taskItem',
  addOptions() {
    return { HTMLAttributes: {}, tabId: '' };
  },
  atom: true, // leaf: no ProseMirror content. Title/meta come from the entity.
  selectable: true,
  draggable: false, // drag-to-reorder (= moving the ref in the doc) is a later phase.

  addAttributes() {
    return {
      id: {
        default: null,
        // Kept for parity with the legacy node; atoms don't split, but a stray clone still gets a
        // fresh id from SyncPlugin's de-dup pass.
        keepOnSplit: false,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Leaf node: no content hole. The React node view supplies the visible title/meta.
    return ['li', mergeAttributes({ 'data-type': 'taskItem' }, this.options.HTMLAttributes, HTMLAttributes)];
  },
});
