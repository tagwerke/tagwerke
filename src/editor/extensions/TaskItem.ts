import { Node, mergeAttributes } from '@tiptap/core';
import { useStore } from '../../store';

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
    // P0: the node carries only `id`. Status/done live on the task entity in the store
    // (single source of truth), read by TaskItemView. The `done` node attr is gone.
    return {
      id: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
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
      'Mod-Enter': () => toggleDoneAtSelection(this.editor.state, this.name),
    };
  },

  addCommands() {
    return {
      // Toggle done by flipping the entity status in the store (done is derived).
      toggleTaskDone:
        (pos) =>
        ({ state }) => {
          const id = taskIdAt(state, this.name, pos);
          if (!id) return false;
          useStore.getState().toggleTaskDone(id);
          return true;
        },
    };
  },
});

/** The id of the taskItem at `pos`, or the one containing the selection. */
function taskIdAt(state: import('@tiptap/pm/state').EditorState, nodeName: string, pos?: number): string | null {
  if (pos != null) {
    const node = state.doc.nodeAt(pos);
    return node && node.type.name === nodeName ? ((node.attrs.id as string | null) ?? null) : null;
  }
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    if ($from.node(depth).type.name === nodeName) {
      return ($from.node(depth).attrs.id as string | null) ?? null;
    }
  }
  return null;
}

function toggleDoneAtSelection(state: import('@tiptap/pm/state').EditorState, nodeName: string): boolean {
  const id = taskIdAt(state, nodeName);
  if (!id) return false;
  useStore.getState().toggleTaskDone(id);
  return true;
}
