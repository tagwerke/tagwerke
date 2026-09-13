// A task's own page (SPRINTS_PLAN.md follow-up) — `/b/:boardId/task/:taskId`, a real route with
// back-button support. Supersedes the icon-strip (TaskMeta) as the primary place a task's fields
// get edited; TaskMeta stays for quick glances/edits on list/kanban rows. Comments + history are
// NOT rebuilt here — ActivityDrawer already has them interleaved, just embedded inline instead of
// as its overlay popover.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore, childrenOf } from '../store';
import { StatusControl } from './StatusControl';
import { ActivityDrawer } from './ActivityDrawer';
import { flush as flushPersist } from '../api/persist';
import { navigate, boardTaskPath, boardPath } from '../util/router';
import type { ID, TaskStatus } from '../types';

/** One row of the field rail. Only here to say the label/control wrapper once. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="task-page-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

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

  const children = childrenOf(tasks, taskId);
  const close = () => navigate(boardPath(boardId));

  if (!task) {
    // The task was deleted/trashed out from under an open page (a peer's action, or a stale
    // link) — there is nothing to show. Back to the board rather than a dead page.
    return (
      <main className="tab-view tab-open task-page">
        <div className="view-placeholder muted">This task is gone.</div>
        <button className="btn ghost" onClick={close}>Back to board</button>
      </main>
    );
  }

  const status: TaskStatus = task.status ?? 'todo';

  return (
    <main className="tab-view tab-open task-page">
      <header className="board-head">
        <button className="back-btn" onClick={close} aria-label="back to board">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>{tab?.name ?? 'Board'}</span>
        </button>
      </header>

      <div className="task-page-body">
        <div className="task-page-main">
          <div className="task-page-title-row">
            {/* Same two calls TaskRow makes. setTaskMeta used to be wired here instead, which
                skipped the requireReview gate and the sub-task cascade offer — a board's approval
                rule held on a row but not on the task's own page. */}
            <StatusControl
              status={status}
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

          <textarea
            className="task-page-description"
            value={draft?.id === task.id ? draft.text : task.description ?? ''}
            disabled={!editable}
            placeholder="Description — add detail, context, links…"
            onFocus={() => putDraft({ id: task.id, text: task.description ?? '' })}
            onChange={(e) => putDraft({ id: task.id, text: e.target.value })}
            onBlur={(e) => {
              putDraft(null);
              // persist.ts already debounces the network at 400ms; this guard is only so an
              // in-and-out of the field does not churn the store for nothing.
              if (e.target.value !== (task.description ?? '')) setTaskMeta(task.id, { description: e.target.value });
            }}
          />

          {children.length > 0 && (
            <div className="task-page-subtasks">
              <div className="task-page-subtasks-head">Sub-tasks</div>
              <ul>
                {children.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="task-page-subtask-link" onClick={() => navigate(boardTaskPath(boardId, c.id))}>
                      <span className={`list-dot status-${c.status ?? 'todo'}`} />
                      {c.text || <em className="muted">(empty)</em>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ActivityDrawer kind="task" id={task.id} boardId={boardId} title={task.text} onClose={close} embedded />
        </div>

        <aside className="task-page-fields">
          {/* No Status field here: the StatusControl in the title row is the one status affordance,
              shared with board rows and the Planner. */}
          <Field label="Assignee">
            <select
              value={task.assigneeId ?? ''}
              disabled={!editable}
              onChange={(e) => setTaskMeta(task.id, { assigneeId: e.target.value || undefined })}
            >
              <option value="">Unassigned</option>
              {members?.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Reviewer">
            <select
              value={task.reviewerId ?? ''}
              disabled={!editable}
              onChange={(e) => setTaskMeta(task.id, { reviewerId: e.target.value || undefined })}
            >
              <option value="">None</option>
              {members?.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Priority">
            <select
              value={task.priority ?? ''}
              disabled={!editable}
              onChange={(e) => setTaskMeta(task.id, { priority: e.target.value ? (Number(e.target.value) as 1 | 2 | 3) : undefined })}
            >
              <option value="">None</option>
              <option value="1">!</option>
              <option value="2">!!</option>
              <option value="3">!!!</option>
            </select>
          </Field>

          <Field label="Date">
            <input
              type="date"
              value={task.date ?? ''}
              disabled={!editable}
              onChange={(e) => setTaskMeta(task.id, { date: e.target.value || undefined })}
            />
          </Field>

          <Field label="Sprint">
            <select
              value={task.sprintId ?? ''}
              disabled={!editable}
              onChange={(e) => setTaskMeta(task.id, { sprintId: e.target.value || undefined })}
            >
              <option value="">Backlog</option>
              {sprints?.map((sp) => (
                <option key={sp.id} value={sp.id}>{sp.label}{sp.isCurrent ? ' (current)' : ''}</option>
              ))}
            </select>
          </Field>
        </aside>
      </div>
    </main>
  );
}
