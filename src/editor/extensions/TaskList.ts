import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { createTaskAtParagraph } from '../createTaskAt';

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
      // "- " at the start of an (otherwise empty) paragraph → a task list holding one id-only ref
      // atom. The title lives on the entity, so nothing text-bearing is created; SyncPlugin mirrors
      // the empty row and the node view (via requestTaskFocus) takes the caret.
      new InputRule({
        find: /^\s*-\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          chain()
            .command(({ view, dispatch }) => (dispatch ? createTaskAtParagraph(view, $from.pos) : true))
            .run();
        },
      }),
    ];
  },
});
