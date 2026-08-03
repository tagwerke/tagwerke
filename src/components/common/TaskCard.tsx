// A compact task card for the Kanban board: text + priority + assignee. Reads the same task
// entity as every other view. `onOpen` (optional) jumps to the task in the doc.

import { useMemo, useState } from 'react';
import { childrenOf, useStore } from '../../store';
import { Avatar } from './Avatar';
import { MoveTaskMenu } from './MoveTaskMenu';
import { SubtaskProgress } from './SubtaskProgress';
import { TaskParentPath } from './TaskParentPath';
import type { ID } from '../../types';

export function TaskCard({ taskId, onOpen, draggable, onDragStart, expandable = false }: {
  taskId: ID;
  onOpen?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  /**
   * Let the roll-up strip open an inline list of this task's sub-tasks. Only meaningful in the
   * Commitments scope, where sub-tasks have no cards of their own — in "All work" they are already
   * on the wall and showing them inside the parent as well would just duplicate them
   * (SUBTASKS_PLAN P6).
   */
  expandable?: boolean;
}) {
  const task = useStore((s) => s.tasks[taskId]);
  const tasks = useStore((s) => s.tasks);
  const members = useStore((s) => (task ? s.membersByBoard[task.homeTabId] : undefined));
  const [open, setOpen] = useState(false);
  const allKids = useMemo(() => childrenOf(tasks, taskId), [tasks, taskId]);
  // Only a task that HAS sub-tasks gets the affordance — otherwise every root card would carry an
  // empty, clickable, invisible button.
  const canExpand = expandable && allKids.length > 0;
  const kids = canExpand && open ? allKids : [];
  if (!task) return null;

  const assignee = task.assigneeId ? members?.find((m) => m.id === task.assigneeId)?.name : undefined;
  const name = assignee ?? task.owner ?? undefined;

  return (
    <article
      className={`task-card ${task.parentTaskId ? 'is-subtask' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
    >
      {/* Status columns split a family across the board, so a card has to say what it is part of.
          A card has the room for a caption line; the denser List rows use an inline crumb. */}
      <TaskParentPath taskId={task.id} variant="caption" />
      <div className="task-card-text">{task.text || <em className="muted">(empty)</em>}</div>

      {canExpand ? (
        <button
          type="button"
          className="task-card-expand"
          title={open ? 'Hide sub-tasks' : 'Show sub-tasks'}
          onClick={(e) => {
            e.stopPropagation(); // the card itself opens the task; the strip opens the list
            setOpen((v) => !v);
          }}
        >
          <SubtaskProgress taskId={task.id} className="on-card" />
        </button>
      ) : (
        <SubtaskProgress taskId={task.id} className="on-card" />
      )}

      {kids.length > 0 && (
        <ul className="task-card-subs">
          {kids.map((k) => (
            <li key={k.id} className={`task-card-sub status-${k.status ?? 'todo'}`}>
              <span className={`list-dot status-${k.status ?? 'todo'}`} />
              <span className="task-card-sub-text">{k.text || <em className="muted">(empty)</em>}</span>
            </li>
          ))}
        </ul>
      )}

      {/* The footer is the card's action line: priority on the left, then the move action and the
          assignee. It renders whether or not the task has either, so putting the action here costs
          the card no height — and keeps it clear of the parent caption a sub-task card carries at
          the top, which a corner button would sit on top of. */}
      <div className="task-card-foot">
        {task.priority ? <span className={`task-card-prio p${task.priority}`}>{'!'.repeat(task.priority)}</span> : <span />}
        <MoveTaskMenu taskId={task.id} className="on-card" />
        {name && <Avatar name={name} size={20} />}
      </div>
    </article>
  );
}
