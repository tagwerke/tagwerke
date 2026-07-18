// Cross-cutting focus signal for task-title widgets (TASKS_AS_ENTITIES.md P2). A command that
// creates a new task ref (Enter, the "- " input rule) can't focus the new title synchronously —
// the React node view mounts a tick later, and TipTap attaches the node-view DOM to the document
// AFTER React's mount effect runs. So the creator records the id here; the mounting TaskItemView
// waits for the element to be connected, then focuses it (caret at end) and consumes the request.
//
// The request is peeked (not consumed) until focus actually lands, so React StrictMode's
// throwaway first mount can't swallow it before the real element is in the document.

const pending = new Set<string>();

/** Ask the (soon-to-mount) title widget for `id` to take focus once it renders + connects. */
export function requestTaskFocus(id: string): void {
  pending.add(id);
}

/** Is a focus pending for `id`? (Non-consuming.) */
export function peekTaskFocus(id: string): boolean {
  return pending.has(id);
}

/** Clear a pending focus for `id` (called once focus has actually landed). */
export function consumeTaskFocus(id: string): void {
  pending.delete(id);
}

/** Focus a contentEditable element and place the caret at the end (`false`) or start (`true`). */
function focusAt(el: HTMLElement, toStart: boolean): void {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(toStart);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Focus a contentEditable element with the caret at the end of its text. */
export function focusEnd(el: HTMLElement): void {
  focusAt(el, false);
}

/** Focus a contentEditable element with the caret at the start of its text. */
export function focusStart(el: HTMLElement): void {
  focusAt(el, true);
}

/** Focus the title widget of the task `id` under `root`, caret at the given edge. Returns false
 *  if the widget isn't in the DOM. The bridge between ProseMirror's selection and the widgets. */
export function focusTaskWidget(root: HTMLElement, id: string, where: 'start' | 'end'): boolean {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  const el = root.querySelector(`li[data-type="taskItem"][data-id="${esc}"] .task-title`);
  if (!(el instanceof HTMLElement)) return false;
  (where === 'start' ? focusStart : focusEnd)(el);
  return true;
}
