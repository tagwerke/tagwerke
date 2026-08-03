// Dragging a task around inside its board — reorder and re-nest in one gesture.
//
// The keyboard equivalents already exist (Enter / Tab / Shift-Tab, see taskTree.ts) and this is the
// same set of writes reached with a pointer: the ROW owns the tree, so a drop is a parent + rank
// change, and the DOCUMENT is touched only at the two boundaries where a task's root-ness changes
// — plus the one case the keyboard never produces, a root reordered against another root, where
// the ref has to travel with it or the doc and the outline would disagree about the order.
//
// Drop zones are read off the pointer's position within the row's OWN line:
//
//   ┌──────────────── top 30%    → before  (sibling above the target)
//   │  Fix the login bug          middle   → into    (last sub-task of the target)
//   └──────────────── bottom 30% → after   (sibling below the target)
//
// "Its own line" is load-bearing: a parent's <li> contains its whole subtree, so its bounding box
// is as tall as the family. Measuring against that would put the thresholds somewhere off-screen.
// The sub-task <ul> is the boundary — everything above it is the row itself.

import type { Editor } from '@tiptap/react';
import { Fragment, Slice } from '@tiptap/pm/model';
import { childrenOf, siblingsOf, taskDepth, useStore } from '../store';
import { MAX_TASK_DEPTH } from '../../shared/tree';
import { insertRefAfter, insertRefBefore, placeRefAt, refPositions, removeRef } from './docRefs';
import { subtreeHeight } from './taskTree';
import type { ID, Task } from '../types';

export type DropZone = 'before' | 'after' | 'into';

/** How far a finger must travel before a press becomes a drag rather than a tap. */
const TOUCH_SLOP = 5;
/** Distance from the scroll container's edge at which a drag starts scrolling it. */
const EDGE = 56;
const EDGE_SPEED = 12;

/** The MIME type carrying the dragged task id. Also how a drop tells our drags from a file/text
 *  drag — dataTransfer contents are unreadable during dragover, but the type list is not. */
export const TASK_DRAG_TYPE = 'application/x-tagwerke-task';

// The dragged id, mirrored in a module variable because the drop-target handlers need it during
// DRAGOVER (to decide whether the drop is even legal, and thus which indicator to show) and the
// spec deliberately hides dataTransfer data until the drop event.
let draggingId: ID | null = null;

/**
 * `view.dragging` is set to the slice this drag would insert — a taskList holding the ref — for one
 * reason: the drop cursor. ProseMirror's dropcursor plugin draws its line at `dropPoint(doc, pos,
 * slice)` when a slice is known, and at a raw text position when it isn't. Since TaskDropTarget
 * lands the ref at exactly that `dropPoint`, handing over the slice makes the line the editor shows
 * and the place the task ends up the same thing by construction, rather than two calculations that
 * have to be kept in agreement.
 *
 * `move: false` so that IF a drop ever escapes TaskDropTarget, ProseMirror inserts rather than
 * cutting something out. The server's reconcile de-duplicates a stray ref; it cannot un-delete.
 */
export function beginTaskDrag(e: React.DragEvent, id: ID, editor: Editor): void {
  draggingId = id;
  e.dataTransfer.setData(TASK_DRAG_TYPE, id);
  e.dataTransfer.setData('text/plain', useStore.getState().tasks[id]?.text ?? '');
  e.dataTransfer.effectAllowed = 'move';

  const { taskItem, taskList } = editor.state.schema.nodes;
  if (taskItem && taskList) {
    const slice = new Slice(Fragment.from(taskList.create(null, taskItem.create({ id }))), 0, 0);
    editor.view.dragging = { slice, move: false };
  }
}

/**
 * Clear both halves of the drag state. `view.dragging` has to be cleared HERE: ProseMirror clears
 * it on its own dragend handler, but that handler never runs for us — the drag starts inside a node
 * view whose stopEvent tells ProseMirror the event isn't its business — so a stale slice would
 * otherwise sit there and be inserted by the next unrelated drop into the editor.
 */
export function endTaskDrag(editor?: Editor): void {
  draggingId = null;
  if (editor && !editor.isDestroyed) editor.view.dragging = null;
}

export function draggedTaskId(): ID | null {
  return draggingId;
}

/**
 * How tall the row's own line is, excluding any sub-task list nested inside it. Falls back to the
 * full height for a leaf, which has nothing nested and so is its own line.
 */
export function ownLineHeight(li: HTMLElement): number {
  const rect = li.getBoundingClientRect();
  const kids = li.querySelector(':scope > .task-children');
  if (!kids) return rect.height;
  return Math.max(1, kids.getBoundingClientRect().top - rect.top);
}

/** Which third of the row's own line the pointer is in. `y` is measured from the top of the line. */
export function zoneFor(y: number, lineHeight: number): DropZone {
  if (y < lineHeight * 0.3) return 'before';
  if (y > lineHeight * 0.7) return 'after';
  return 'into';
}

/** The parent a task would end up under, given a target and a zone. null = a top-level task. */
function parentForDrop(tasks: Record<ID, Task>, targetId: ID, zone: DropZone): ID | null {
  if (zone === 'into') return targetId;
  return tasks[targetId]?.parentTaskId ?? null;
}

/** True when `maybeAncestor` is `id` itself or sits anywhere above it. Bounded against a cycle. */
function isSelfOrAncestor(tasks: Record<ID, Task>, id: ID, maybeAncestor: ID): boolean {
  let cur: ID | undefined = maybeAncestor;
  const seen = new Set<ID>();
  while (cur && !seen.has(cur) && seen.size <= MAX_TASK_DEPTH + 2) {
    if (cur === id) return true;
    seen.add(cur);
    cur = tasks[cur]?.parentTaskId;
  }
  return false;
}

/**
 * Is this drop legal? Refused rather than corrected, so the row shows no indicator and the cursor
 * says "no" — a silently relocated drop is worse than one that doesn't happen.
 *
 *   - nothing may be dropped onto itself, or into its own subtree (a cycle no tree walk survives);
 *   - the deepest leaf travelling with the task has to still fit under the nesting limit. Mirrors
 *     the server's parentRefusal and canNest, so pointer and keyboard agree on where the wall is;
 *   - the target must be on the same board — a cross-board move is a different operation entirely
 *     (see tasks/moveToBoard.ts), with a roster and two documents to reconcile.
 */
export function canDrop(tasks: Record<ID, Task>, dragId: ID, targetId: ID, zone: DropZone): boolean {
  const drag = tasks[dragId];
  const target = tasks[targetId];
  if (!drag || !target || dragId === targetId) return false;
  if (drag.homeTabId !== target.homeTabId) return false;
  // Any target inside the dragged subtree makes the task its own ancestor — landing INSIDE it for
  // an `into` drop, and landing beside one of its own descendants for a before/after drop (whose
  // parent is, by definition, also within the subtree).
  if (isSelfOrAncestor(tasks, dragId, targetId)) return false;
  const parentId = parentForDrop(tasks, targetId, zone);
  const depth = parentId ? taskDepth(tasks, parentId) + 1 : 0;
  return depth + subtreeHeight(tasks, dragId) <= MAX_TASK_DEPTH;
}

/**
 * Perform the drop: one row write, plus whatever the document owes.
 *
 * Order matters. The store write goes FIRST, because SyncPlugin's GC reads the rows to decide
 * whether a ref that vanished from the doc means "this task was deleted" — a task that is already
 * recorded as someone's child by the time its ref goes is correctly left alone. Both document
 * edits then dispatch synchronously, so the GC (which runs in a microtask) never observes the gap
 * between them. This is the same ordering nestTask/unnestTask rely on.
 */
export function applyDrop(editor: Editor, dragId: ID, targetId: ID, zone: DropZone): void {
  const store = useStore.getState();
  const tasks = store.tasks;
  const drag = tasks[dragId];
  const target = tasks[targetId];
  if (!drag || !target || !canDrop(tasks, dragId, targetId, zone)) return;

  const parentId = parentForDrop(tasks, targetId, zone);

  // The two neighbours the task is landing between. Excluding the dragged task itself matters when
  // it is already in this list: otherwise it would be measured against its own current position.
  let before: ID | undefined;
  let after: ID | undefined;
  if (zone === 'into') {
    const kids = childrenOf(tasks, targetId).filter((k) => k.id !== dragId);
    before = kids[kids.length - 1]?.id; // append: after the last existing sub-task
  } else {
    const sibs = siblingsOf(tasks, target.homeTabId, target.parentTaskId).filter((s) => s.id !== dragId);
    const idx = sibs.findIndex((s) => s.id === targetId);
    if (zone === 'before') {
      before = idx > 0 ? sibs[idx - 1].id : undefined;
      after = targetId;
    } else {
      before = targetId;
      after = idx >= 0 ? sibs[idx + 1]?.id : undefined;
    }
  }

  const wasRoot = !drag.parentTaskId;
  const willBeRoot = parentId == null;

  store.moveTask(dragId, { parentTaskId: parentId, before, after });

  if (wasRoot && !willBeRoot) {
    // It became someone's sub-task, so it no longer occupies a slot in the prose (D2).
    removeRef(editor, dragId);
  } else if (!wasRoot && willBeRoot) {
    // Promoted to the top level → it needs a slot of its own, beside the task it landed next to.
    if (zone === 'before') insertRefBefore(editor, targetId, dragId);
    else insertRefAfter(editor, targetId, dragId);
  } else if (wasRoot && willBeRoot) {
    // Root reordered against another root. The rank alone is not enough: the doc renders roots in
    // DOCUMENT order, so the ref has to travel too or the doc and every other view would disagree
    // about the order. Yjs has no atomic move, so this is a delete + insert — the same shape the
    // server's reconcile already de-duplicates when two people drag the same task at once.
    removeRef(editor, dragId);
    if (zone === 'before') insertRefBefore(editor, targetId, dragId);
    else insertRefAfter(editor, targetId, dragId);
  }
  // (child → child: the tree is entirely in the rows, and no ref exists to move.)
}

// ── Touch ────────────────────────────────────────────────────────────────────────────────────
//
// HTML5 drag-and-drop is a mouse gesture. `dragstart` does not fire from a touch on iOS at all, and
// where it does fire it is behind a long-press on a target that, in the row's left gutter, is far
// smaller than a fingertip. So touch gets its own implementation on pointer events — the same shape
// the calendar already drags with (EventCard): pointer capture, a movement threshold, and
// `touch-action: none` so the browser doesn't take the gesture as a scroll.
//
// It deliberately targets ROWS only, not positions in the prose. Placing a task between two
// paragraphs is a precise instruction that wants a drop cursor to aim with, and there is no drop
// cursor without dragover; on a phone it is also not the gesture anyone reaches for. Rows cover
// nearly the whole surface, and "after the last row" reaches the end of the list anyway.

interface TouchDrag {
  id: ID;
  editor: Editor;
  startX: number;
  startY: number;
  moved: boolean;
  scroller: HTMLElement | null;
  raf: number;
  edge: number; // px/frame the scroller is currently drifting by, 0 when still
}

let touch: TouchDrag | null = null;

/** The row a touch drag is currently over, published so the row can draw its own indicator. */
let touchDrop: { id: ID; zone: DropZone; height: number } | null = null;
const touchListeners = new Set<() => void>();

export function subscribeTouchDrop(fn: () => void): () => void {
  touchListeners.add(fn);
  return () => { touchListeners.delete(fn); };
}

/** The live touch target for `id`, or null. Identity is stable while unchanged, so a row can read
 *  it straight from useSyncExternalStore without re-rendering on every move. */
export function touchDropFor(id: ID): { id: ID; zone: DropZone; height: number } | null {
  return touchDrop && touchDrop.id === id ? touchDrop : null;
}

function setTouchDrop(next: { id: ID; zone: DropZone; height: number } | null): void {
  const same = touchDrop === next
    || (touchDrop && next && touchDrop.id === next.id && touchDrop.zone === next.zone && touchDrop.height === next.height);
  if (same) return;
  touchDrop = next;
  for (const fn of touchListeners) fn();
}

/** The nearest ancestor that actually scrolls — what a drag near the screen edge should move. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/** Resolve the row under the finger, and where within it the task would land. */
function targetUnder(clientX: number, clientY: number, dragId: ID): { id: ID; zone: DropZone; height: number } | null {
  const el = document.elementFromPoint(clientX, clientY);
  const li = el?.closest?.('.task-item') as HTMLElement | null;
  const id = li?.getAttribute('data-id');
  if (!li || !id) return null;
  const height = ownLineHeight(li);
  const y = clientY - li.getBoundingClientRect().top;
  // Over the row's SUBTREE rather than its own line: the descendant row owns that space, and
  // elementFromPoint has already returned it — so anything past the line here is a miss.
  if (y < 0 || y > height) return null;
  const zone = zoneFor(y, height);
  if (!canDrop(useStore.getState().tasks, dragId, id, zone)) return null;
  return { id, zone, height };
}

function stopTouch(): void {
  if (touch?.raf) cancelAnimationFrame(touch.raf);
  touch = null;
  draggingId = null;
  setTouchDrop(null);
}

/**
 * Pointer handlers for the grab handle. Mouse is left alone — it has the HTML5 path, which brings
 * the drop cursor and prose positions with it, and running both would apply every drop twice.
 */
export function touchDragHandlers(editor: Editor, id: ID) {
  const finish = (e: React.PointerEvent): void => {
    const t = touch;
    if (!t || t.id !== id) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    const landing = t.moved ? touchDrop : null;
    stopTouch();
    if (landing) applyDrop(editor, id, landing.id, landing.zone);
  };

  return {
    onPointerDown(e: React.PointerEvent): void {
      if (e.pointerType === 'mouse') return;
      e.preventDefault(); // no synthetic click, no text selection, no scroll
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      draggingId = id;
      touch = {
        id, editor, startX: e.clientX, startY: e.clientY, moved: false,
        scroller: scrollParent(e.currentTarget as HTMLElement), raf: 0, edge: 0,
      };
    },

    onPointerMove(e: React.PointerEvent): void {
      const t = touch;
      if (!t || t.id !== id) return;
      if (!t.moved && Math.abs(e.clientY - t.startY) < TOUCH_SLOP && Math.abs(e.clientX - t.startX) < TOUCH_SLOP) return;
      t.moved = true;
      setTouchDrop(targetUnder(e.clientX, e.clientY, id));

      // Drift the list when the finger nears an edge, so a drag can reach past one screenful.
      // Re-resolving the target each frame is what makes the indicator follow the moving content
      // rather than freeze under a stationary finger.
      const box = t.scroller?.getBoundingClientRect();
      const top = box?.top ?? 0;
      const bottom = box?.bottom ?? window.innerHeight;
      t.edge = e.clientY < top + EDGE ? -EDGE_SPEED : e.clientY > bottom - EDGE ? EDGE_SPEED : 0;
      if (t.edge && !t.raf) {
        const { clientX, clientY } = e;
        const step = (): void => {
          if (!touch || !touch.edge) { if (touch) touch.raf = 0; return; }
          if (touch.scroller) touch.scroller.scrollTop += touch.edge;
          else window.scrollBy(0, touch.edge);
          setTouchDrop(targetUnder(clientX, clientY, id));
          touch.raf = requestAnimationFrame(step);
        };
        t.raf = requestAnimationFrame(step);
      }
    },

    onPointerUp: finish,
    onPointerCancel(): void {
      if (touch?.id === id) stopTouch();
    },
  };
}

/**
 * Drop onto the PROSE — between paragraphs, on an empty line, at the end of the document.
 *
 * A root task occupies a real slot in the document (D2), so a position in the prose is a genuine
 * destination and not a near-miss: "this task belongs here, between these two paragraphs". The task
 * becomes a root wherever it lands, since only roots have a place in the document at all — dropping
 * a sub-task into the prose promotes it, carrying its own sub-tasks with it.
 *
 * The subtle part is that TWO orders have to come out agreeing. The document decides what the Doc
 * view shows; `rank` decides what List, Kanban and every other view show. So the rank is computed
 * from the refs the drop lands BETWEEN in document order — not from wherever the task used to sit —
 * and the ref is placed at the matching spot in the same breath.
 */
export function dropTaskInProse(editor: Editor, dragId: ID, docPos: number): boolean {
  const store = useStore.getState();
  const drag = store.tasks[dragId];
  if (!drag) return false;

  // The roots this position falls between, in document order. The dragged task is excluded: it is
  // about to move, so its current slot says nothing about where it is going.
  const refs = refPositions(editor).filter((r) => r.id !== dragId);
  const beforeRef = [...refs].reverse().find((r) => r.pos < docPos);
  const afterRef = refs.find((r) => r.pos >= docPos);

  store.moveTask(dragId, { parentTaskId: null, before: beforeRef?.id, after: afterRef?.id });
  placeRefAt(editor, dragId, docPos);
  return true;
}
