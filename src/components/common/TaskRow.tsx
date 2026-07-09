// The canonical non-editor task row: status control + text + metadata caption. A projection
// of the shared task entity used by the List view, the agenda rail, and mobile. Edits write
// straight through the store actions (status → entity, no doc round-trip). Reuses the exact
// StatusControl + TaskMeta affordances (and the existing `.task-row` grid) so a row here looks
// and behaves like a task line in the doc. Supersedes PlannerTaskLine.

import { useStore } from '../../store';
import { StatusControl } from '../StatusControl';
import { TaskMeta } from '../TaskMeta';
import type { ID, TaskStatus } from '../../types';

export function TaskRow({
  taskId,
  editable = true,
  indent = 0,
  onOpen,
}: {
  taskId: ID;
  editable?: boolean;
  /** Sub-task nesting depth (renders a left indent + connector). */
  indent?: number;
  /** Click the text to jump to the task in its board's doc. */
  onOpen?: () => void;
}) {
  const task = useStore((s) => s.tasks[taskId]);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  if (!task) return null;

  const status: TaskStatus = task.status ?? 'todo';
  const done = status === 'done' || status === 'cancelled';

  return (
    <div
      className={`task-row ${done ? 'is-done' : ''} ${indent ? 'is-sub' : ''}`}
      style={indent ? { marginLeft: indent * 26 } : undefined}
    >
      <StatusControl
        status={status}
        disabled={!editable}
        onToggle={() => toggleTaskDone(task.id)}
        onPick={(s) => setTaskStatus(task.id, s)}
      />
      <button
        type="button"
        className="task-text"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? 'Open in board' : undefined}
      >
        {task.text || <em className="muted">(empty)</em>}
      </button>
      <TaskMeta taskId={task.id} editable={editable} />
    </div>
  );
}
