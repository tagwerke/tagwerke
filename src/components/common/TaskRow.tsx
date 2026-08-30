// The one task row (NOTES_SPLIT_PLAN §N3).
//
// Status, title, open. That is the whole row, and it is the same row in the table, the agenda and
// on a phone. Everything a row used to carry — the owner chip, the reviewer select, the approve
// button, the priority and due chips, the move menu, the comment bubble — is reachable from the
// action menu (right-click, the `⋯`, or `.`) or on the task's own page. Nine controls became three.
//
// This is not a tidying preference. Four renderers each grew their own copy of those affordances,
// so adding a field meant touching all four and they drifted anyway; the row that shows the least
// is the one that cannot drift.

import { useState } from 'react';
import { useStore } from '../../store';
import { StatusControl } from '../StatusControl';
import { SubtaskProgress } from './SubtaskProgress';
import { TaskParentPath } from './TaskParentPath';
import { TaskActionMenu } from './TaskActionMenu';
import type { ID, TaskStatus } from '../../types';

export function TaskRow({ taskId, editable = true, indent = 0, showParent = false, onOpen }: {
  taskId: ID;
  editable?: boolean;
  /** Sub-task nesting depth (renders a left indent). */
  indent?: number;
  /**
   * Show the `Parent ›` crumb before the title. For groupings that split a family apart (status,
   * assignee, date) this is what tells you what a sub-task belongs to.
   */
  showParent?: boolean;
  onOpen?: () => void;
}) {
  const task = useStore((s) => s.tasks[taskId]);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!task) return null;

  const status: TaskStatus = task.status ?? 'todo';
  const done = status === 'done' || status === 'cancelled';

  return (
    <div
      className={`task-row ${done ? 'is-done' : ''} ${indent ? 'is-sub' : ''}`}
      style={indent ? { marginLeft: indent * 26 } : undefined}
      onContextMenu={editable ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      <StatusControl
        status={status}
        disabled={!editable}
        onToggle={() => toggleTaskDone(task.id)}
        onPick={(s) => setTaskStatus(task.id, s)}
      />
      <span className="task-text-wrap">
        {showParent ? <TaskParentPath taskId={task.id} variant="inline" /> : null}
        <button
          type="button"
          className="task-text"
          onClick={onOpen}
          disabled={!onOpen}
          title={onOpen ? 'Open task' : undefined}
        >
          {task.text || <em className="muted">(empty)</em>}
        </button>
        <SubtaskProgress taskId={task.id} />
      </span>

      {/* Right-click works too, but a gesture-only affordance is one nobody finds — the same
          lesson the comment button taught (COMMENTS_PLAN §8). */}
      {editable && (
        <button
          type="button"
          className="icon-btn task-row-menu"
          aria-label="Task actions"
          title="Task actions"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setMenu({ x: box.left, y: box.bottom + 4 });
          }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
            <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
          </svg>
        </button>
      )}
      {onOpen && (
        <button type="button" className="icon-btn task-row-open" aria-label="Open task" title="Open task" onClick={onOpen}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <path d="M6 3h7v7M13 3L4 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {menu && (
        <TaskActionMenu
          ids={[task.id]}
          tabId={task.homeTabId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
