import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core';

export const TaskList = Node.create({
  name: 'taskList',
  group: 'block list',
  content: 'taskItem+',

  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]', priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes({ 'data-type': 'taskList' }, HTMLAttributes), 0];
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*-\s$/,
        type: this.type,
      }),
    ];
  },
});
