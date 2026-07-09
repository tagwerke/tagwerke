// A compact task card for the Kanban board: text + priority + assignee. Reads the same task
// entity as every other view. `onOpen` (optional) jumps to the task in the doc.

import { useStore } from '../../store';
import { Avatar } from './Avatar';
import type { ID } from '../../types';

export function TaskCard({ taskId, onOpen, draggable, onDragStart }: {
  taskId: ID;
  onOpen?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  const task = useStore((s) => s.tasks[taskId]);
  const members = useStore((s) => (task ? s.membersByBoard[task.homeTabId] : undefined));
  if (!task) return null;

  const assignee = task.assigneeId ? members?.find((m) => m.id === task.assigneeId)?.name : undefined;
  const name = assignee ?? task.owner ?? undefined;

  return (
    <article className="task-card" draggable={draggable} onDragStart={onDragStart} onClick={onOpen}>
      <div className="task-card-text">{task.text || <em className="muted">(empty)</em>}</div>
      <div className="task-card-foot">
        {task.priority ? <span className={`task-card-prio p${task.priority}`}>{'!'.repeat(task.priority)}</span> : <span />}
        {name && <Avatar name={name} size={20} />}
      </div>
    </article>
  );
}
