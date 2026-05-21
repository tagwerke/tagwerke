import { Node, mergeAttributes, wrappingInputRule, InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

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
    const type = this.type;
    return [
      wrappingInputRule({
        find: /^\s*-\s$/,
        type,
      }),
      // "- " after a Shift-Enter hardBreak. TipTap's textBefore renders leaf
      // nodes as the literal "%leaf%", but that placeholder is 6 chars while
      // the hardBreak is 1 doc position — so `range.from` is unusable here.
      // Instead, locate the hardBreak by walking the parent paragraph.
      new InputRule({
        find: /\n\s*-\s$/,
        handler: ({ state, range, chain }) => {
          const $cursor = state.doc.resolve(range.to);
          const paragraph = $cursor.parent;
          const paraContentStart = $cursor.start();
          let hardBreakOffset = -1;
          paragraph.forEach((child, offset) => {
            if (child.type.name === 'hardBreak' && offset < $cursor.parentOffset) {
              hardBreakOffset = offset;
            }
          });
          if (hardBreakOffset < 0) return null;
          const from = paraContentStart + hardBreakOffset;
          const to = range.to;
          chain()
            .command(({ tr, dispatch }) => {
              tr.delete(from, to);
              tr.split(from);
              tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
              if (dispatch) dispatch(tr);
              return true;
            })
            .wrapIn(type)
            .run();
        },
      }),
    ];
  },
});
