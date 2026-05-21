import { Node, mergeAttributes } from '@tiptap/core';

export interface TaskItemOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    taskItem: {
      toggleTaskDone: (pos?: number) => ReturnType;
    };
  }
}

export const TaskItem = Node.create<TaskItemOptions>({
  name: 'taskItem',
  addOptions() {
    return { HTMLAttributes: {} };
  },
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
      done: {
        default: false,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-done') === 'true',
        renderHTML: (attrs) => ({ 'data-done': attrs.done ? 'true' : 'false' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'li',
      mergeAttributes({ 'data-type': 'taskItem' }, this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
      'Shift-Enter': () => {
        // Escape the task list: insert an empty paragraph after the outermost
        // taskList containing the cursor, and put the cursor there.
        const { state, view } = this.editor;
        const { $from } = state.selection;
        let listDepth = -1;
        for (let d = $from.depth; d >= 0; d--) {
          if ($from.node(d).type.name === 'taskList') listDepth = d;
        }
        if (listDepth < 0) return false;
        const afterList = $from.after(listDepth);
        const para = state.schema.nodes.paragraph.create();
        const tr = state.tr.insert(afterList, para);
        const sel = state.selection.constructor;
        const newPos = afterList + 1;
        tr.setSelection(
          // @ts-expect-error TextSelection.near is the correct API at runtime
          sel.near(tr.doc.resolve(newPos))
        );
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      'Mod-Enter': () => {
        const { state } = this.editor;
        const { $from } = state.selection;
        for (let depth = $from.depth; depth >= 0; depth--) {
          if ($from.node(depth).type.name === 'taskItem') {
            const pos = $from.before(depth);
            const node = state.doc.nodeAt(pos);
            if (!node) return false;
            return this.editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, done: !node.attrs.done });
                return true;
              })
              .run();
          }
        }
        return false;
      },
    };
  },

  addCommands() {
    return {
      toggleTaskDone:
        (pos) =>
        ({ tr, state, dispatch }) => {
          let target = pos;
          if (target == null) {
            const { $from } = state.selection;
            for (let depth = $from.depth; depth >= 0; depth--) {
              if ($from.node(depth).type.name === this.name) {
                target = $from.before(depth);
                break;
              }
            }
          }
          if (target == null) return false;
          const node = state.doc.nodeAt(target);
          if (!node || node.type.name !== this.name) return false;
          if (dispatch) {
            tr.setNodeMarkup(target, undefined, { ...node.attrs, done: !node.attrs.done });
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
