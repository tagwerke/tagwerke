import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { focusTaskWidget } from '../taskFocus';

// Prose ↔ task cursor bridge (TASKS_AS_ENTITIES.md P2, the boundary R1). A task is an id-only atom
// whose title lives in a contentEditable widget, NOT in ProseMirror. So when the PM caret leaves a
// prose block toward a task, PM would create a NodeSelection on the atom — which shows no text
// caret ("the cursor disappears"). This plugin intercepts that crossing and focuses the task's
// title widget instead (down → caret at start, up → at end). The reverse (task → prose) is handled
// in TaskItemView's own key handler. A guard also redirects any stray NodeSelection on a taskItem
// (e.g. from a click) into its widget so there is always a visible caret.

const key = new PluginKey('do-task-nav');

/** The task-ref atom the caret would move into when leaving the current textblock in `dir`, or null. */
function adjacentTaskItemId(state: EditorState, dir: 'up' | 'down'): string | null {
  const { $from } = state.selection;
  const idx = $from.index(0); // index of the top-level block holding the caret
  const sib = dir === 'down' ? state.doc.maybeChild(idx + 1) : state.doc.maybeChild(idx - 1);
  if (!sib || sib.type.name !== 'taskList') return null;
  const item = dir === 'down' ? sib.firstChild : sib.lastChild;
  return (item?.attrs.id as string | null) ?? null;
}

export const TaskNav = Extension.create({
  name: 'doTaskNav',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
            const dir = event.key === 'ArrowDown' ? 'down' : 'up';
            const { selection } = view.state;
            // Only act on a collapsed caret that is on the exiting edge of its textblock, so
            // intra-paragraph line navigation is untouched.
            if (!selection.empty || !view.endOfTextblock(dir)) return false;
            const id = adjacentTaskItemId(view.state, dir);
            if (!id) return false;
            if (focusTaskWidget(view.dom as HTMLElement, id, dir === 'down' ? 'start' : 'end')) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
        // Guard: a NodeSelection on a task atom (e.g. from a click on its chrome) shows no caret —
        // hand focus to the widget. Only while PM itself holds focus, so we never steal it.
        view() {
          return {
            update(v) {
              if (!v.hasFocus()) return;
              const sel = v.state.selection;
              if (sel instanceof NodeSelection && sel.node.type.name === 'taskItem') {
                const id = sel.node.attrs.id as string | null;
                if (id) focusTaskWidget(v.dom as HTMLElement, id, 'end');
              }
            },
          };
        },
      }),
    ];
  },
});
