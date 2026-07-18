// Node view for a task REFERENCE atom (TASKS_AS_ENTITIES.md P2). The task's title + metadata live
// on the entity (store.tasks[id]); this renders them. The title is an editable widget bound to the
// row (NOT ProseMirror text) — edits go straight to the store (LWW; persist.ts PATCHes, peers get
// it live via the entity channel). Structural keys (Enter/Backspace/Tab/…) are handled here and
// expressed as doc ref operations + entity writes. The node is an atom with stopEvent:()=>true
// (see Editor.tsx), so ProseMirror leaves the widget's own keyboard/selection alone.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { nanoid } from 'nanoid';
import { useStore } from '../store';
import { TaskMeta } from '../components/TaskMeta';
import { StatusControl } from '../components/StatusControl';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { consumeTaskFocus, focusEnd, focusTaskWidget, peekTaskFocus, requestTaskFocus } from './taskFocus';
import { TaskTitleSuggest } from './TaskTitleSuggest';
import type { ID, Task, TaskStatus } from '../types';

interface KeyCtx {
  editor: Editor;
  getPos: () => number | undefined;
  id: string;
  tabId: ID;
  task: Task | undefined;
  el: HTMLElement;
}

/** The task-ref atom immediately before `pos` in the doc, or null. */
function prevTaskItemId(editor: Editor, pos: number): string | null {
  let prev: string | null = null;
  editor.state.doc.descendants((node, p) => {
    if (p >= pos) return false;
    if (node.type.name === 'taskItem') prev = (node.attrs.id as string | null) ?? prev;
    return true;
  });
  return prev;
}

/** Move browser focus to the adjacent task widget (DOM order), caret at end. */
function focusAdjacentTask(editor: Editor, currentId: string, dir: 'up' | 'down'): boolean {
  const items = Array.from(editor.view.dom.querySelectorAll('li[data-type="taskItem"]')) as HTMLElement[];
  const idx = items.findIndex((el) => el.getAttribute('data-id') === currentId);
  if (idx < 0) return false;
  const target = items[idx + (dir === 'up' ? -1 : 1)];
  const title = target?.querySelector('.task-title') as HTMLElement | null;
  if (!title) return false;
  focusEnd(title);
  return true;
}

/** Insert a new task-ref atom after this one, create its row, and focus it. */
function createSiblingAfter(ctx: KeyCtx): void {
  const { editor, getPos, tabId, task } = ctx;
  const pos = getPos();
  if (pos == null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const newId = `t_${nanoid(8)}`;
  useStore.getState().upsertTask({
    id: newId,
    homeTabId: task?.homeTabId ?? tabId,
    text: '',
    parentTaskId: task?.parentTaskId, // a sibling shares this task's parent
  });
  requestTaskFocus(newId);
  const after = pos + node.nodeSize;
  editor.view.dispatch(editor.state.tr.insert(after, editor.schema.nodes.taskItem.create({ id: newId })));
}

/** Delete this task: remove its ref atom (and the taskList if it was the last), soft-delete the row. */
function deleteSelf(ctx: KeyCtx): void {
  const { editor, getPos, id } = ctx;
  const pos = getPos();
  if (pos == null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  focusAdjacentTask(editor, id, 'up'); // move focus off before the node unmounts
  useStore.getState().deleteTask(id); // store removal → persist DELETE → server soft-delete
  const $pos = editor.state.doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  if ($pos.parent.type.name === 'taskList' && $pos.parent.childCount === 1) {
    from = $pos.before(); // last item in its list → remove the empty list too
    to = from + $pos.parent.nodeSize;
  }
  editor.view.dispatch(editor.state.tr.delete(from, to));
}

/** Nest under the preceding sibling (Tab) or lift one level (Shift-Tab) — a row-field change. */
function nest(ctx: KeyCtx): void {
  const { editor, getPos, id } = ctx;
  const pos = getPos();
  if (pos == null) return;
  const prev = prevTaskItemId(editor, pos);
  if (prev && prev !== id) useStore.getState().setTaskParent(id, prev);
}
function unnest(ctx: KeyCtx): void {
  const { id, task } = ctx;
  const parent = task?.parentTaskId;
  const grand = parent ? useStore.getState().tasks[parent]?.parentTaskId : undefined;
  useStore.getState().setTaskParent(id, grand);
}

/** True when the caret is on the first (up) / last (down) VISUAL line of the title, so we cross the
 *  boundary rather than move within a wrapped title. Rect-based, so a single-line title crosses on
 *  the first press regardless of column. */
function caretAtEdge(el: HTMLElement, dir: 'up' | 'down'): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const caret = sel.getRangeAt(0).cloneRange().getBoundingClientRect();
  if (caret.top === 0 && caret.bottom === 0) return true; // empty/edge caret with no rect
  const box = el.getBoundingClientRect();
  const tol = 6;
  return dir === 'up' ? caret.top - box.top < tol : box.bottom - caret.bottom < tol;
}

/** Move to the element IMMEDIATELY adjacent to this task in DOC order (respecting prose between
 *  tasks): a sibling task in the same list, the edge task of an adjacent list, or an adjacent prose
 *  block (PM caret). This is the task→(prose|task) bridge; it must not skip over prose the way a
 *  DOM-widget-order jump would. */
function navFromTask(ctx: KeyCtx, dir: 'up' | 'down'): void {
  const { editor, getPos } = ctx;
  const pos = getPos();
  if (pos == null) return;
  const { doc } = editor.state;
  // The top-level taskList containing this taskItem.
  let found: PMNode | null = null;
  let listStart = 0;
  let topIdx = -1;
  doc.forEach((child, offset, index) => {
    if (offset <= pos && pos < offset + child.nodeSize) { found = child; listStart = offset; topIdx = index; }
  });
  // `found` is only assigned inside the callback, so TS narrows it to null here — re-widen.
  const taskList = found as PMNode | null;
  if (!taskList || taskList.type.name !== 'taskList') return;
  // This taskItem's index within the list.
  let idx = -1;
  taskList.forEach((_item, offset, index) => { if (listStart + 1 + offset === pos) idx = index; });

  const focusItem = (item: PMNode | null | undefined, where: 'start' | 'end') => {
    const id = item?.attrs?.id as string | undefined;
    if (id) focusTaskWidget(editor.view.dom as HTMLElement, id, where);
  };

  // A sibling task in the same list?
  if (dir === 'up' && idx > 0) return focusItem(taskList.child(idx - 1), 'end');
  if (dir === 'down' && idx >= 0 && idx < taskList.childCount - 1) return focusItem(taskList.child(idx + 1), 'start');

  // At the list edge → the adjacent top-level block.
  const sib = dir === 'up' ? doc.maybeChild(topIdx - 1) : doc.maybeChild(topIdx + 1);
  if (!sib) return; // nothing beyond the list in this direction
  if (sib.type.name === 'taskList') {
    return focusItem(dir === 'up' ? sib.child(sib.childCount - 1) : sib.child(0), dir === 'up' ? 'end' : 'start');
  }
  // Adjacent prose block → place the PM caret in it and hand focus back to ProseMirror.
  const at = dir === 'up' ? listStart : listStart + taskList.nodeSize;
  const sel = TextSelection.near(doc.resolve(at), dir === 'up' ? -1 : 1);
  editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
  editor.view.focus();
}

/** Shift-Enter: escape into a fresh prose paragraph DIRECTLY below this task. Mid-list that means
 *  splitting the taskList in two and writing between them; after the last item it degrades to the
 *  old behavior (insert after the list). */
function escapeToParagraph(ctx: KeyCtx): void {
  const { editor, getPos } = ctx;
  const pos = getPos();
  if (pos == null) return;
  const { doc } = editor.state;
  const item = doc.nodeAt(pos);
  if (!item) return;
  const afterTask = pos + item.nodeSize; // boundary between this task and the next, inside the list
  const $pos = doc.resolve(pos);
  const listEnd = $pos.after($pos.depth); // after the whole taskList
  const tr = editor.state.tr;
  let paraAt: number;
  if (afterTask + 1 >= listEnd) {
    // Last item in the list → paragraph goes after the list itself.
    paraAt = listEnd;
  } else {
    // Split the taskList at this task; the paragraph lands in the gap between the two halves.
    tr.split(afterTask, 1);
    paraAt = afterTask + 1;
  }
  tr.insert(paraAt, editor.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(paraAt + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** True when the (collapsed) caret sits at the very start of the title widget. */
function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const rng = sel.getRangeAt(0).cloneRange();
  rng.setStart(el, 0);
  return rng.toString() === '';
}

function onTitleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, ctx: KeyCtx): void {
  const el = e.currentTarget;
  const empty = (el.textContent ?? '') === '';

  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    useStore.getState().toggleTaskDone(ctx.id);
    return;
  }
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    escapeToParagraph(ctx);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    createSiblingAfter(ctx);
    return;
  }
  if (e.key === 'Backspace' && empty) {
    e.preventDefault();
    deleteSelf(ctx);
    return;
  }
  if (e.key === 'Backspace' && caretAtStart(el)) {
    // Caret at the start of a non-empty title: nothing to delete here — hop to the end of the
    // previous task/prose line instead (doc-editor muscle memory). Deliberately NOT a merge:
    // tasks are entities with history, not text lines.
    e.preventDefault();
    navFromTask(ctx, 'up');
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) unnest(ctx);
    else nest(ctx);
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const dir = e.key === 'ArrowUp' ? 'up' : 'down';
    if (!caretAtEdge(el, dir)) return; // let the caret move within a wrapped title first
    e.preventDefault();
    navFromTask(ctx, dir); // move to the immediately-adjacent block (prose or task), in doc order
  }
}

export function TaskItemView({ node, editor, getPos, extension }: NodeViewProps) {
  const id: string | null = node.attrs.id ?? null;
  const tabId: ID = (extension.options as { tabId: ID }).tabId;
  const task = useStore((s) => (id ? s.tasks[id] : undefined));
  const project = useStore((s) => {
    if (!task) return undefined;
    const tab = s.tabs[task.homeTabId];
    return tab ? s.projects[tab.projectId] : undefined;
  });
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const [historyOpen, setHistoryOpen] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);

  const status: TaskStatus = task?.status ?? 'todo';
  const done = status === 'done';
  const cancelled = status === 'cancelled';
  const editable = editor.isEditable;
  const text = task?.text ?? '';

  // Visual indent from the parentTaskId chain (the doc itself is flat).
  const depth = useStore((s) => {
    let d = 0;
    let cur = id ? s.tasks[id]?.parentTaskId : undefined;
    let guard = 0;
    while (cur && guard++ < 12) {
      d++;
      cur = s.tasks[cur]?.parentTaskId;
    }
    return d;
  });

  // Sync the widget's text FROM the store when it diverges and we're not the one typing (covers
  // the initial mount + remote/LWW edits without stealing the caret mid-edit).
  useEffect(() => {
    const el = titleRef.current;
    if (el && el.textContent !== text && document.activeElement !== el) el.textContent = text;
  }, [text]);

  // A just-created task asked for focus. TipTap attaches the node-view DOM to the document only
  // AFTER this mount effect, so wait for the element to be connected (retry a few frames), then
  // focus + consume. Peeking (not consuming) up front means StrictMode's throwaway mount can't eat
  // the request before the surviving element is in the document.
  useEffect(() => {
    if (!id || !peekTaskFocus(id)) return;
    let raf = 0;
    let tries = 0;
    const tryFocus = () => {
      const el = titleRef.current;
      if (el && el.isConnected) {
        consumeTaskFocus(id);
        focusEnd(el);
      } else if (tries++ < 10) {
        raf = requestAnimationFrame(tryFocus);
      }
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [id]);

  if (!id) {
    return <NodeViewWrapper as="li" data-type="taskItem" className="task-item" />;
  }

  return (
    <NodeViewWrapper
      as="li"
      data-type="taskItem"
      data-id={id}
      data-status={status}
      className={`task-item status-${status} ${done || cancelled ? 'is-done' : ''} ${cancelled ? 'is-cancelled' : ''}`}
      style={depth ? { marginInlineStart: `${depth * 1.5}rem` } : undefined}
    >
      <StatusControl
        status={status}
        accentColor={project?.color}
        onToggle={() => toggleTaskDone(id)}
        onPick={(s) => setTaskStatus(id, s)}
      />
      <div
        ref={titleRef}
        className="task-title"
        contentEditable={editable}
        suppressContentEditableWarning
        role="textbox"
        data-placeholder="Task"
        onInput={(e) => useStore.getState().setTaskText(id, e.currentTarget.textContent ?? '')}
        onKeyDown={(e) => onTitleKeyDown(e, { editor, getPos, id, tabId, task, el: e.currentTarget })}
      />
      {editable ? <TaskTitleSuggest inputRef={titleRef} taskId={id} tabId={tabId} /> : null}
      <TaskMeta taskId={id} />
      {/* History is reachable on every task — a quiet trailing action revealed on row hover. */}
      {task ? (
        <button
          type="button"
          className="icon-btn task-history-btn"
          contentEditable={false}
          title="View history"
          onClick={() => setHistoryOpen(true)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      {historyOpen && task ? (
        <HistoryDrawer kind="task" id={id} boardId={task.homeTabId} title={task.text || 'task'} onClose={() => setHistoryOpen(false)} />
      ) : null}
    </NodeViewWrapper>
  );
}
