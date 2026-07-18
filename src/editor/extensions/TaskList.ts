import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { nanoid } from 'nanoid';
import { requestTaskFocus } from '../taskFocus';

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
    const listType = this.type;
    return [
      // "- " at the start of an (otherwise empty) paragraph → a task list holding one id-only ref
      // atom. The title lives on the entity, so nothing text-bearing is created; SyncPlugin mirrors
      // the empty row and the node view (via requestTaskFocus) takes the caret.
      new InputRule({
        find: /^\s*-\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') return null;
          const taskItem = state.schema.nodes.taskItem;
          if (!taskItem) return null;
          const id = `t_${nanoid(8)}`;
          const paraStart = $from.before();
          const paraEnd = paraStart + $from.parent.nodeSize;
          requestTaskFocus(id);
          chain()
            .command(({ tr, dispatch }) => {
              if (dispatch) tr.replaceWith(paraStart, paraEnd, listType.create(null, taskItem.create({ id })));
              return true;
            })
            .run();
        },
      }),
    ];
  },
});
