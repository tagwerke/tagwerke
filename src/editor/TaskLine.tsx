// One task row inside the document — status control, editable title widget, metadata, history.
//
// Factored out of TaskItemView because a row now appears in two guises (SUBTASKS_PLAN D2):
//   - a ROOT is a ProseMirror node view, occupying a slot in the prose;
//   - a CHILD is plain React, rendered by its root's node view from the store rows.
// Both must look and behave identically — same keys, same affordances — so both render this.
//
// The title is an editable widget bound to the ROW, not ProseMirror text. Edits go straight to the
// store (LWW; persist.ts PATCHes, peers get it live over the entity channel). The enclosing atom
// sets stopEvent:()=>true so ProseMirror leaves the widget's keyboard and selection alone.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { TaskMeta } from '../components/TaskMeta';
import { StatusControl } from '../components/StatusControl';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { MoveTaskMenu } from '../components/common/MoveTaskMenu';
import { consumeTaskFocus, focusEnd, peekTaskFocus } from './taskFocus';
import { TaskTitleSuggest } from './TaskTitleSuggest';
import { parseEmbeddedCommands } from './embeddedCommands';
import { createSiblingAfter, deleteTaskLine, nestTask, unnestTask } from './taskTree';
import { findRefPos } from './docRefs';
import { navFromTaskLine } from './taskNav';
import { applyDrop, beginTaskDrag, canDrop, draggedTaskId, endTaskDrag, ownLineHeight, zoneFor, type DropZone } from './taskDnd';
import type { ID, TaskStatus } from '../types';

/**
 * Runs on losing focus: strips any embedded `/command` / `@mention` tokens out of the title and
 * applies them as real fields, so writing "Fix login bug /p1 /due tomorrow" and clicking away works
 * the same as picking each one from the interactive popup while typing.
 */
function commitEmbeddedCommands(id: ID, tabId: ID): void {
  const s = useStore.getState();
  const task = s.tasks[id];
  if (!task) return;
  const members = s.membersByBoard[tabId] ?? [];
  const meId = useSession.getState().user?.id;
  const { cleanText, fields } = parseEmbeddedCommands(task.text, members, meId);
  if (cleanText === task.text && !fields.status && fields.date === undefined && fields.priority === undefined && fields.assigneeId === undefined) return;

  if (fields.status) s.setTaskStatus(id, fields.status);
  if (fields.date !== undefined) s.setTaskMeta(id, { date: fields.date });
  if (fields.priority !== undefined) s.setTaskMeta(id, { priority: fields.priority ?? undefined });
  if (fields.assigneeId !== undefined) s.setTaskAssignee(id, fields.assigneeId ?? undefined);
  if (cleanText !== task.text) s.setTaskText(id, cleanText);
}

/** True when the (collapsed) caret sits at the very start of the title widget. */
function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const rng = sel.getRangeAt(0).cloneRange();
  rng.setStart(el, 0);
  return rng.toString() === '';
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

export interface TaskLineProps {
  id: ID;
  tabId: ID;
  editor: Editor;
  /** Root only: lets Shift-Enter split the enclosing taskList to write prose between tasks. */
  getPos?: () => number | undefined;
  /** Nesting depth, for the indent guide. 0 = a root. */
  depth: number;
  /** This task's own sub-task list, rendered into the row's third grid area. */
  children?: ReactNode;
}

export function TaskLine({ id, tabId, editor, getPos, depth, children }: TaskLineProps) {
  const task = useStore((s) => s.tasks[id]);
  const project = useStore((s) => {
    if (!task) return undefined;
    const tab = s.tabs[task.homeTabId];
    return tab ? s.projects[tab.projectId] : undefined;
  });
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const [historyOpen, setHistoryOpen] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);
  // Where a drop would land, and how tall this row's own line is (the indicator is drawn against
  // the line, not the <li>, which is as tall as the whole family). Null = not a drop target now.
  const [drop, setDrop] = useState<{ zone: DropZone; height: number } | null>(null);

  const status: TaskStatus = task?.status ?? 'todo';
  const done = status === 'done';
  const cancelled = status === 'cancelled';
  const editable = editor.isEditable;
  const text = task?.text ?? '';

  // Sync the widget's text FROM the store when it diverges and we're not the one typing (covers the
  // initial mount + remote/LWW edits without stealing the caret mid-edit).
  useEffect(() => {
    const el = titleRef.current;
    if (el && el.textContent !== text && document.activeElement !== el) el.textContent = text;
  }, [text]);

  // A just-created task asked for focus. TipTap attaches node-view DOM to the document only AFTER
  // this mount effect, so wait for the element to be connected (retry a few frames), then focus +
  // consume. Peeking (not consuming) up front means StrictMode's throwaway mount can't eat the
  // request before the surviving element is in the document.
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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    const empty = (el.textContent ?? '') === '';

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggleTaskDone(id);
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      escapeToParagraph(editor, id, getPos);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      createSiblingAfter(editor, id, tabId);
      return;
    }
    if (e.key === 'Backspace' && empty) {
      e.preventDefault();
      navFromTaskLine(editor, id, 'up'); // move focus off before the row unmounts
      deleteTaskLine(editor, id);
      return;
    }
    if (e.key === 'Backspace' && caretAtStart(el)) {
      // Caret at the start of a non-empty title: nothing to delete here — hop to the end of the
      // previous task/prose line instead (doc-editor muscle memory). Deliberately NOT a merge:
      // tasks are entities with history, not text lines.
      e.preventDefault();
      navFromTaskLine(editor, id, 'up');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) unnestTask(editor, id);
      else nestTask(editor, id);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const dir = e.key === 'ArrowUp' ? 'up' : 'down';
      if (!caretAtEdge(el, dir)) return; // let the caret move within a wrapped title first
      e.preventDefault();
      navFromTaskLine(editor, id, dir);
    }
  };

  /**
   * Drag events are NOT stopped from bubbling: a sub-task's <li> is nested inside its parent's, so
   * every ancestor row sees the same dragover. Each one answers the same question — "is the pointer
   * on MY line?" — and only the single row that can say yes claims the drop or paints an indicator.
   * That is self-correcting: an ancestor whose line the pointer has left clears itself on the very
   * next move, with no coordination between rows and no stale indicator left behind.
   */
  const onDragOver = (e: React.DragEvent<HTMLLIElement>): void => {
    const dragId = draggedTaskId();
    if (!dragId || !editable) return; // not one of our task drags (text, a file) — leave it alone
    const li = e.currentTarget;
    const height = ownLineHeight(li);
    const y = e.clientY - li.getBoundingClientRect().top;
    if (y < 0 || y > height) {
      setDrop(null); // over my subtree, not my line — that row will handle it
      return;
    }
    e.preventDefault(); // without this the browser refuses the drop outright
    const zone = zoneFor(y, height);
    const ok = canDrop(useStore.getState().tasks, dragId, id, zone);
    e.dataTransfer.dropEffect = ok ? 'move' : 'none';
    setDrop(ok ? { zone, height } : null);
  };

  const onDrop = (e: React.DragEvent<HTMLLIElement>): void => {
    const dragId = draggedTaskId();
    setDrop(null);
    if (!dragId || !drop || !editable) return;
    e.preventDefault();
    applyDrop(editor, dragId, id, drop.zone);
    endTaskDrag();
  };

  return (
    <li
      data-type="taskItem"
      data-id={id}
      data-status={status}
      data-depth={depth}
      data-drop={drop?.zone}
      style={drop ? ({ '--drop-h': `${drop.height}px` } as React.CSSProperties) : undefined}
      className={`task-item status-${status} ${done || cancelled ? 'is-done' : ''} ${cancelled ? 'is-cancelled' : ''} ${depth ? 'is-subtask' : ''}`}
      onDragOver={onDragOver}
      // Only when the pointer leaves the ROW — dragleave also fires moving between the row's own
      // parts (title → meta), and clearing on those would strobe the indicator. A cancelled drag
      // has no relatedTarget, so it still clears.
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}
      onDrop={onDrop}
    >
      {editable ? (
        <span
          className="task-drag-handle"
          contentEditable={false}
          draggable
          role="presentation"
          title="Drag to reorder or nest"
          onDragStart={(e) => beginTaskDrag(e, id)}
          onDragEnd={endTaskDrag}
        >
          <svg viewBox="0 0 10 16" width="10" height="14" aria-hidden>
            <circle cx="3" cy="4" r="1.1" /><circle cx="7" cy="4" r="1.1" />
            <circle cx="3" cy="8" r="1.1" /><circle cx="7" cy="8" r="1.1" />
            <circle cx="3" cy="12" r="1.1" /><circle cx="7" cy="12" r="1.1" />
          </svg>
        </span>
      ) : null}
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
        data-placeholder={depth ? 'Sub-task' : 'Task — try / or @'}
        onInput={(e) => useStore.getState().setTaskText(id, e.currentTarget.textContent ?? '')}
        onKeyDown={onKeyDown}
        onBlur={() => commitEmbeddedCommands(id, tabId)}
      />
      {editable ? <TaskTitleSuggest inputRef={titleRef} taskId={id} tabId={tabId} /> : null}
      <TaskMeta taskId={id} />
      {/* Trailing actions, revealed on row hover: move the task to another board, and its history.
          The move lives here as well as on the card/list row so it is in the same place in every
          view — and it is the only way to reach another board, since dragging can't leave this one. */}
      {task && editable ? <MoveTaskMenu taskId={id} /> : null}
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
      {children}
    </li>
  );
}

/**
 * Shift-Enter: escape into a fresh prose paragraph directly below this task. Only a root has a
 * position in the document, so for a sub-task we escape below its ROOT's block — the nearest
 * meaningful place, since prose cannot live inside a subtree.
 */
function escapeToParagraph(editor: Editor, id: ID, getPos?: () => number | undefined): void {
  const pos = getPos?.();
  if (pos != null) return splitAt(editor, pos);
  // A child has no position of its own — escape below its root's block instead.
  const rootId = rootOf(id);
  if (!rootId || rootId === id) return;
  const rootPos = findRefPos(editor, rootId);
  if (rootPos != null) splitAt(editor, rootPos);
}

function rootOf(id: ID): ID | null {
  const tasks = useStore.getState().tasks;
  let cur: ID | undefined = id;
  const seen = new Set<ID>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const parent: ID | undefined = tasks[cur]?.parentTaskId;
    if (!parent) return cur;
    cur = parent;
  }
  return null;
}

/** Split the enclosing taskList at `pos` and drop an empty paragraph into the gap. */
function splitAt(editor: Editor, pos: number): void {
  const { doc } = editor.state;
  const item = doc.nodeAt(pos);
  if (!item) return;
  const afterTask = pos + item.nodeSize; // boundary between this task and the next, inside the list
  const $pos = doc.resolve(pos);
  const listEnd = $pos.after($pos.depth); // after the whole taskList
  const tr = editor.state.tr;
  let paraAt: number;
  if (afterTask + 1 >= listEnd) {
    paraAt = listEnd; // last item in the list → the paragraph goes after the list itself
  } else {
    tr.split(afterTask, 1); // split the list; the paragraph lands in the gap between the halves
    paraAt = afterTask + 1;
  }
  tr.insert(paraAt, editor.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(paraAt + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
