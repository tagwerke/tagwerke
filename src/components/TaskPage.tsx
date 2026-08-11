// A task's own page (SPRINTS_PLAN.md follow-up) — `/b/:boardId/task/:taskId`, a real route with
// back-button support. Supersedes the icon-strip (TaskMeta) as the primary place a task's fields
// get edited; TaskMeta stays for quick glances/edits on list/kanban rows. Comments + history are
// NOT rebuilt here — ActivityDrawer already has them interleaved, just embedded inline instead of
// as its overlay popover.

import { useRef } from 'react';
import { useStore, childrenOf } from '../store';
import { StatusControl, STATUS_ORDER, STATUS_LABEL } from './StatusControl';
import { ActivityDrawer } from './ActivityDrawer';
import { navigate, boardTaskPath, boardPath } from '../util/router';
import type { ID, TaskStatus } from '../types';

export function TaskPage({ taskId, boardId }: { taskId: ID; boardId: ID }) {
  const task = useStore((s) => s.tasks[taskId]);
  const tasks = useStore((s) => s.tasks);
  const tab = useStore((s) => s.tabs[boardId]);
  const members = useStore((s) => s.membersByBoard[boardId]);
  const sprints = useStore((s) => s.sprintsByBoard[boardId]);
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const setTaskText = useStore((s) => s.setTaskText);
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const editable = tab?.role === 'editor' || tab?.role === 'admin';
  const titleOnFocus = useRef('');

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
            <StatusControl
              status={status}
              disabled={!editable}
              onToggle={() => toggleTaskDone(task.id)}
              onPick={(s) => setTaskMeta(task.id, { status: s })}
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
            value={task.description ?? ''}
            disabled={!editable}
            placeholder="Description — add detail, context, links…"
            onChange={(e) => setTaskMeta(task.id, { description: e.target.value })}
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
          <label className="task-page-field">
            <span>Status</span>
            <select value={status} disabled={!editable} onChange={(e) => setTaskMeta(task.id, { status: e.target.value as TaskStatus })}>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </label>

          <label className="task-page-field">
            <span>Assignee</span>
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
          </label>

          <label className="task-page-field">
            <span>Reviewer</span>
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
          </label>

          <label className="task-page-field">
            <span>Priority</span>
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
          </label>

          <label className="task-page-field">
            <span>Date</span>
            <input
              type="date"
              value={task.date ?? ''}
              disabled={!editable}
              onChange={(e) => setTaskMeta(task.id, { date: e.target.value || undefined })}
            />
          </label>

          <label className="task-page-field">
            <span>Sprint</span>
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
          </label>
        </aside>
      </div>
    </main>
  );
}
