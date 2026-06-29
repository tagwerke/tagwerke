// One task line inside a block's live mini-board. Per the product direction, the only
// task management surfaced in the Planner is STATUS — everything else is read-only
// display; full editing happens on the tab itself. Status edits write straight to the
// shared entity (no sync), so a flip here reflects on the home tab immediately.

import { useStore } from '../../store';
import { StatusControl } from '../StatusControl';
import { TaskMeta } from '../TaskMeta';
import type { ID, TaskStatus } from '../../types';

export function PlannerTaskLine({ taskId, readOnly }: { taskId: ID; readOnly?: boolean }) {
  const task = useStore((s) => s.tasks[taskId]);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  if (!task) return null;
  const status: TaskStatus = task.status ?? 'todo';

  return (
    <li className={`planner-task status-${status} ${status === 'done' || status === 'cancelled' ? 'is-done' : ''}`}>
      <StatusControl
        status={status}
        disabled={readOnly}
        onToggle={() => toggleTaskDone(task.id)}
        onPick={(s) => setTaskStatus(task.id, s)}
      />
      <span className="planner-task-text">{task.text || <em className="muted">(empty)</em>}</span>
      <TaskMeta taskId={task.id} />
    </li>
  );
}
