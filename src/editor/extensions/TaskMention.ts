// A task MENTION: the only way a task appears in a document now (NOTES_SPLIT_PLAN §N4).
//
// The rule the whole plan turns on is that a document may reference a task but never contain one,
// and this node is that rule made literal. It is an inline atom carrying an id and nothing else —
// no title, no status, no children — so the row stays the single source of truth and deleting the
// mention deletes a reference, never the task.
//
// It replaces `taskItem`, which was a BLOCK that owned a slot in the prose and had to be kept in
// step with the task's rank by taskDnd/docRefs/SyncPlugin and a server-side reconcile. None of that
// applies to a mention: it has no order to agree with and nothing to reconcile.

import { Node, mergeAttributes } from '@tiptap/core';

export interface TaskMentionOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const TaskMention = Node.create<TaskMentionOptions>({
  name: 'taskMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  // Not draggable: dragging one out of a sentence and into another would read as moving the task,
  // which is exactly the confusion this node exists to end.
  draggable: false,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="taskMention"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // No content hole — the React node view renders the live title from the store, so a renamed
    // task reads correctly in every note that mentions it without the documents being rewritten.
    return ['span', mergeAttributes({ 'data-type': 'taskMention' }, this.options.HTMLAttributes, HTMLAttributes)];
  },
});
