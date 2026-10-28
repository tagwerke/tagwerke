// A task's own page (SPRINTS_PLAN.md follow-up) — `/b/:boardId/task/:taskId`, a real route with
// back-button support. Supersedes the icon-strip (TaskMeta) as the primary place a task's fields
// get edited; TaskMeta stays for quick glances/edits on list/kanban rows. Comments + history are
// NOT rebuilt here — ActivityDrawer already has them interleaved, just embedded inline instead of
// as its overlay popover.
//
// One surface (the task-page redesign, 2026-10-28). Sections are told apart by a heading and a
// rule, never by a card of their own; the only box on the page is the comment field, because it
// is the only thing that is always waiting to be typed into. A section with nothing in it shrinks
// to a one-line "+ Sub-task" / "+ Attach a file" affordance, so a fresh task reads short instead of
// like an empty form.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useStore, childrenOf, ancestorsOf, taskDepth } from '../store';
import { StatusControl } from './StatusControl';
import { ActivityDrawer } from './ActivityDrawer';
import { DocumentStrip } from './documents/DocumentStrip';
import { TaskRow } from './common/TaskRow';
import { QuickAdd } from './common/QuickAdd';
import { SubtaskProgress } from './common/SubtaskProgress';
import { TaskActionMenu } from './common/TaskActionMenu';
import { flush as flushPersist } from '../api/persist';
import { navigate, boardTaskPath, boardPath } from '../util/router';
import type { ID } from '../types';
import { newestFirst } from '../util/sprints';
import { formatTimestamp, timeAgo } from '../util/dates';
import { EmptyState } from './common/EmptyState';
import { Dropdown } from './Dropdown';
import { DatePicker } from './common/DatePicker';
import { MAX_TASK_DEPTH } from '../../shared/tree';

/** One row of the property rail: label left, a control that reads as plain text until hovered.
 *  A <label>, so a click on the word opens the control beside it. */
function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="task-prop">
      <span className="task-prop-label">{label}</span>
      <span className="task-prop-value">{children}</span>
    </label>
  );
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : '');

export function TaskPage({ taskId, boardId }: { taskId: ID; boardId: ID }) {
  const task = useStore((s) => s.tasks[taskId]);
  const tasks = useStore((s) => s.tasks);
  const tab = useStore((s) => s.tabs[boardId]);
  const members = useStore((s) => s.membersByBoard[boardId]);
  const sprints = useStore((s) => s.sprintsByBoard[boardId]);
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const setTaskText = useStore((s) => s.setTaskText);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const editable = tab?.role === 'editor' || tab?.role === 'admin';
  const titleOnFocus = useRef('');
  const descRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The sub-task section opened from its collapsed "+ Sub-task" button, before it has a child.
  // Keyed by task so it does not stay open across a navigation to a sibling.
  const [addingTo, setAddingTo] = useState<ID | null>(null);
  // The description is held locally WHILE FOCUSED and committed on blur. Writing per keystroke
  // replaced the task object in the store, which re-rendered this page and the ActivityDrawer
  // embedded below it on every character. Non-null means "someone is typing in this field, their
  // text wins"; null means the store is the truth, so a peer's edit lands the moment you are not
  // in the box — no effect, and nothing to clobber. The id is carried because navigating to a
  // sub-task swaps `taskId` under a mounted page (App.tsx), so a stale draft must not follow.
  const [draft, setDraft] = useState<{ id: ID; text: string } | null>(null);
  // Durability net for that draft. persist.ts guarantees a store edit survives a reload or a tab
  // close (it flushes on beforeunload/visibilitychange), but it can only flush what reached the
  // store — text sitting in React state is invisible to it. Without this, typing a description and
  // hitting refresh loses it, which is precisely the failure the last round of description work was
  // about. The ref shadows the state so the listeners can stay registered once; the cleanup also
  // covers an unmount that never fired blur (closing the page from a keyboard shortcut, or the task
  // being deleted under us).
  const draftRef = useRef<{ id: ID; text: string } | null>(null);
  const putDraft = (next: { id: ID; text: string } | null) => {
    draftRef.current = next;
    setDraft(next);
  };
  useEffect(() => {
    const commit = () => {
      const d = draftRef.current;
      if (!d) return;
      const live = useStore.getState().tasks[d.id];
      if (live && d.text !== (live.description ?? '')) {
        useStore.getState().setTaskMeta(d.id, { description: d.text });
        // Order matters on the unload path: persist.ts registered its own beforeunload/hidden
        // flush at module load, so it has ALREADY run by the time we get here and would never see
        // this write. Flush again ourselves rather than relying on listener order.
        flushPersist();
      }
      draftRef.current = null;
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') commit();
    };
    window.addEventListener('beforeunload', commit);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', commit);
      document.removeEventListener('visibilitychange', onHide);
      commit();
    };
  }, []);

  const description = draft?.id === taskId ? draft.text : task?.description ?? '';
  // The description is prose on the page, not a box with a scrollbar: it grows with its text.
  // (`field-sizing: content` does this in CSS where supported; this covers the rest.)
  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [description]);

  const children = childrenOf(tasks, taskId);
  const close = () => navigate(boardPath(boardId));

  if (!task) {
    // The task was deleted/trashed out from under an open page (a peer's action, or a stale
    // link) — there is nothing to show. Back to the board rather than a dead page.
    return (
      <main className="tab-view tab-open task-page">
        <EmptyState size="block">This task is gone.</EmptyState>
        <button className="btn ghost" onClick={close}>Back to board</button>
      </main>
    );
  }

  // Root first, so the crumbs read Board › Grandparent › Parent.
  const ancestors = ancestorsOf(tasks, task.id).reverse();
  const canNest = editable && taskDepth(tasks, task.id) < MAX_TASK_DEPTH;
  const subtasksOpen = children.length > 0 || addingTo === task.id;

  return (
    <main className="tab-view tab-open task-page">
      <div className="task-page-body">
        <nav className="task-page-crumbs" aria-label="where this task lives">
          <button type="button" className="task-crumb is-board" onClick={close} aria-label={`back to ${tab?.name ?? 'board'}`}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
            <span>{tab?.name ?? 'Board'}</span>
          </button>
          {ancestors.map((a) => (
            <span key={a.id} className="task-crumb-step">
              <span className="task-crumb-sep" aria-hidden>›</span>
              <button type="button" className="task-crumb" onClick={() => navigate(boardTaskPath(boardId, a.id))}>
                {a.text || 'Untitled task'}
              </button>
            </span>
          ))}
          {editable && (
            <button
              type="button"
              className="icon-btn task-page-menu"
              aria-label="Task actions"
              title="Task actions"
              onClick={(e) => {
                // The button sits at the right edge, and the menu opens rightward from x.
                const box = e.currentTarget.getBoundingClientRect();
                setMenu({ x: Math.max(8, Math.min(box.left, window.innerWidth - 260)), y: box.bottom + 4 });
              }}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
                <circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" />
              </svg>
            </button>
          )}
        </nav>

        <div className="task-page-title-row">
          {/* Same two calls TaskRow makes. setTaskMeta used to be wired here instead, which
              skipped the sub-task cascade offer — it held on a row but not on the task's own
              page. */}
          <StatusControl
            tabId={task.homeTabId}
            status={task.status}
            disabled={!editable}
            onToggle={() => toggleTaskDone(task.id)}
            onPick={(s) => setTaskStatus(task.id, s)}
          />
          <input
            className="task-page-title"
            value={task.text}
            disabled={!editable}
            onFocus={() => { titleOnFocus.current = task.text; }}
            onChange={(e) => setTaskText(task.id, e.target.value)}
            onBlur={() => { if (!task.text.trim()) setTaskText(task.id, titleOnFocus.current); }}
            placeholder="Untitled task"
            aria-label="task title"
          />
        </div>

        {/* The aside is the full-height side pane (its rule runs to the foot of the board); the
            inner block is what sticks while the thread scrolls. */}
        <aside className="task-page-props" aria-label="task properties">
          <div className="task-page-props-inner">
          {/* No Status row here: the StatusControl in the title row is the one status affordance,
              shared with board rows and the Planner. */}
          <Prop label="Assignee">
            <Dropdown
              className={task.assigneeId ? '' : 'is-unset'}
              value={task.assigneeId ?? ''}
              disabled={!editable}
              options={[{ value: '', label: 'Unassigned' }, ...(members ?? []).map((m) => ({ value: m.id, label: m.name }))]}
              onChange={(v) => setTaskMeta(task.id, { assigneeId: v || undefined })}
            />
          </Prop>

          <Prop label="Priority">
            <Dropdown
              className={task.priority ? 'is-priority' : 'is-unset'}
              value={task.priority ? String(task.priority) : ''}
              disabled={!editable}
              options={[{ value: '', label: 'None' }, { value: '1', label: '!' }, { value: '2', label: '!!' }, { value: '3', label: '!!!' }]}
              onChange={(v) => setTaskMeta(task.id, { priority: v ? (Number(v) as 1 | 2 | 3) : undefined })}
            />
          </Prop>

          <Prop label="Date">
            <DatePicker
              value={task.date}
              disabled={!editable}
              align="right"
              onChange={(date) => setTaskMeta(task.id, { date })}
            />
          </Prop>

          <Prop label="Sprint">
            <Dropdown
              className={task.sprintId ? '' : 'is-unset'}
              value={task.sprintId ?? ''}
              disabled={!editable}
              options={[{ value: '', label: 'Backlog' }, ...newestFirst(sprints ?? []).map((sp) => ({ value: sp.id, label: `${sp.label}${sp.isCurrent ? ' (current)' : ''}` }))]}
              onChange={(v) => setTaskMeta(task.id, { sprintId: v || undefined })}
            />
          </Prop>

          {/* Created only. An "Updated" line was tried and read wrong: `updatedAt` is server-stamped
              and only arrives with the next state pull, so right after an edit it still showed the
              old date. When something last changed is the Activity section's job. */}
          {task.createdAt && (
            <div className="task-props-foot" title={formatTimestamp(iso(task.createdAt))}>
              Created {timeAgo(iso(task.createdAt))}
            </div>
          )}
          </div>
        </aside>

        <div className="task-page-main">
          <textarea
            ref={descRef}
            className="task-page-description"
            rows={1}
            value={description}
            disabled={!editable}
            placeholder={editable ? 'Add a description…' : 'No description.'}
            aria-label="description"
            onFocus={() => putDraft({ id: task.id, text: task.description ?? '' })}
            onChange={(e) => putDraft({ id: task.id, text: e.target.value })}
            onBlur={(e) => {
              putDraft(null);
              // persist.ts already debounces the network at 400ms; this guard is only so an
              // in-and-out of the field does not churn the store for nothing.
              if (e.target.value !== (task.description ?? '')) setTaskMeta(task.id, { description: e.target.value });
            }}
          />

          {/* Sub-tasks and files share a wrapping row so that, when both are empty, their two
              one-line affordances sit side by side instead of stacking as two empty sections. A
              section with content takes the full width and pushes the other below it. */}
          <div className="task-page-attach">
            {subtasksOpen ? (
              <section className="task-section" aria-label="Sub-tasks">
                <div className="task-section-head">
                  <span className="task-section-title">Sub-tasks</span>
                  <SubtaskProgress taskId={task.id} />
                </div>
                {children.map((c) => (
                  <TaskRow key={c.id} taskId={c.id} editable={editable} onOpen={() => navigate(boardTaskPath(boardId, c.id))} />
                ))}
                {canNest && (
                  <QuickAdd tabId={task.homeTabId} parentTaskId={task.id} placeholder="Add a sub-task" autoFocus={addingTo === task.id && !children.length} />
                )}
              </section>
            ) : (
              canNest && (
                <button type="button" className="task-section-add" onClick={() => setAddingTo(task.id)}>
                  + Sub-task
                </button>
              )
            )}

            {/* Files sit between the write-up and the conversation, which is where they belong in
                the reading order: what this task is, what is attached to it, what was said about
                it. The strip handles its own viewer/editor gate and its own collapsed state. */}
            <DocumentStrip variant="task" boardId={boardId} taskId={task.id} />
          </div>

          <ActivityDrawer kind="task" id={task.id} boardId={boardId} title={task.text} onClose={close} embedded />
        </div>
      </div>

      {menu && (
        <TaskActionMenu ids={[task.id]} tabId={task.homeTabId} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </main>
  );
}
