import { useState } from 'react';
import { useStore } from '../store';
import { Chip } from './Chip';
import { DatePicker } from './DatePicker';
import { formatDateChip, todayISO } from '../util/dates';
import type { ID } from '../types';

// The metadata caption-line shown UNDER a task's title: assignee · priority · due.
// Shared by the editor node view (TaskItemView) and the list view (TaskRow) so the
// tokens, order, and date-picker behaviour live in exactly one place. Collapses to
// nothing when a task has no metadata. `editable` gates the date picker / +date
// affordance (off for read-only contexts).
export function TaskMeta({ taskId, editable = true }: { taskId: ID; editable?: boolean }) {
  const task = useStore((s) => s.tasks[taskId]);
  const members = useStore((s) => (task ? s.membersByBoard[task.homeTabId] : undefined));
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const [dateOpen, setDateOpen] = useState(false);

  if (!task) return null;

  // Assignee shows the member's name (email local-part), falling back to legacy free-text owner.
  const assignee = task.assigneeId ? members?.find((m) => m.id === task.assigneeId)?.name : undefined;
  const ownerLabel = assignee ?? task.owner;
  const active = task.status !== 'done' && task.status !== 'cancelled';
  const overdue = !!task.date && active && task.date < todayISO();

  // Empty state collapses entirely (no row, no reserved height).
  if (!ownerLabel && !task.priority && !task.date) return null;

  return (
    <div className="task-meta" contentEditable={false}>
      {ownerLabel ? <Chip kind="owner">{ownerLabel}</Chip> : null}
      {task.priority ? (
        <Chip kind="priority" priority={task.priority}>{'!'.repeat(task.priority)}</Chip>
      ) : null}
      {task.date ? (
        <button
          type="button"
          className={`meta-date ${overdue ? 'overdue' : ''}`}
          onClick={editable ? () => setDateOpen((v) => !v) : undefined}
          title={editable ? 'Change due date' : undefined}
        >
          {formatDateChip(task.date)}
        </button>
      ) : editable ? (
        <button type="button" className="meta-add-date" title="Set due date" onClick={() => setDateOpen((v) => !v)}>
          ＋date
        </button>
      ) : null}
      {dateOpen && editable ? (
        <DatePicker
          value={task.date}
          onPick={(iso) => {
            setTaskMeta(taskId, { date: iso });
            setDateOpen(false);
          }}
          onClose={() => setDateOpen(false)}
        />
      ) : null}
    </div>
  );
}
