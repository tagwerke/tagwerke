// Owns every drop that carries a dragged task but lands in the PROSE rather than on a task row.
//
// Without this the drop falls through to ProseMirror, and what ProseMirror does with it is worse
// than nothing: its dragover handler preventDefaults unconditionally, so the whole editor advertises
// itself as a drop target, and then — because the drag began inside a node view whose `stopEvent`
// tells ProseMirror the event isn't its business, leaving `view.dragging` unset — it treats the drop
// as foreign data and pastes the `text/plain` payload. The task's title arrived as a plain line with
// no marker while the real task stayed where it was.
//
// The fix is not to stop advertising the target: a root task genuinely does occupy a slot in the
// document, so "put this task here, after this paragraph" is a real instruction. It is to CLAIM the
// drop and carry it out. `handleDrop` is consulted before ProseMirror does anything of its own
// (prosemirror-view: `view.someProp("handleDrop", …)`), and returning true both preventDefaults the
// event — which keeps the browser's native contenteditable drag-move out of it — and stops the
// paste path.
//
// Row drops never reach here: they happen inside a node view, so ProseMirror ignores them and
// TaskLine's own handlers take them (see taskDnd.ts).

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import { draggedTaskId, dropTaskInProse, endTaskDrag, TASK_DRAG_TYPE } from '../taskDnd';

export const TaskDropTarget = Extension.create({
  name: 'taskDropTarget',

  /**
   * Suppress the generic drop cursor over a task ROW. A row draws its own before / into / after
   * indicator, and two lines disagreeing about where the task will land is worse than one. Over the
   * prose the drop cursor stays — there it is the only indicator, and this extension lands the task
   * exactly where it points.
   *
   * Declared here rather than on TaskItem because `disableDropCursor` is a raw ProseMirror node-spec
   * key that TipTap's NodeConfig doesn't carry; `extendNodeSchema` is the seam for exactly that, and
   * the rule belongs with the extension that owns task drops anyway.
   */
  extendNodeSchema(extension) {
    return extension.name === 'taskItem' ? { disableDropCursor: true } : {};
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('taskDropTarget'),
        props: {
          handleDrop(view, event, slice) {
            const dt = (event as DragEvent).dataTransfer;
            // The id travels in a private MIME type, and `draggedTaskId()` is the in-memory
            // fallback for the browsers that withhold dataTransfer contents until the drop.
            const id = dt?.getData(TASK_DRAG_TYPE) || draggedTaskId();
            if (!id || !dt?.types.includes(TASK_DRAG_TYPE)) return false;
            if (!view.editable) return true; // claim it anyway: a viewer must not paste it as text

            const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
            if (!at) { endTaskDrag(editor); return true; }
            // The same call the drop cursor used to draw its line, so the task lands under it
            // rather than near it. Falls back to the raw position when the slice won't fit
            // anywhere (an empty document, say).
            const pos = (slice ? dropPoint(view.state.doc, at.pos, slice) : null) ?? at.pos;

            dropTaskInProse(editor, id, pos);
            endTaskDrag(editor);
            return true;
          },
        },
      }),
    ];
  },
});
