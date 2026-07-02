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
  const requireReview = useStore((s) => (task ? s.tabs[task.homeTabId]?.settings?.requireReview : undefined));
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const [dateOpen, setDateOpen] = useState(false);

  if (!task) return null;

  // Assignee shows the member's name (email local-part), falling back to legacy free-text owner.
  const assignee = task.assigneeId ? members?.find((m) => m.id === task.assigneeId)?.name : undefined;
  const ownerLabel = assignee ?? task.owner;
  const reviewerName = task.reviewerId ? members?.find((m) => m.id === task.reviewerId)?.name : undefined;
  const approverName = task.approvedBy ? members?.find((m) => m.id === task.approvedBy)?.name : undefined;
  const active = task.status !== 'done' && task.status !== 'cancelled';
  const overdue = !!task.date && active && task.date < todayISO();

  // Accountability affordances (reviewer / approve / history) surface only when the board
  // opted into review, or the task already carries a reviewer/approval — default boards stay
  // flat. See AUDIT_IMPLEMENTATION_PLAN §F7.
  const showReview = !!requireReview || !!task.reviewerId || !!task.approvedBy || task.status === 'in_review';

  // Empty state collapses entirely (no row, no reserved height).
  if (!ownerLabel && !task.priority && !task.date && !showReview) return null;

  return (
    <div className="task-meta" contentEditable={false}>
      {ownerLabel ? <Chip kind="owner">{ownerLabel}</Chip> : null}
      {showReview && editable && members && members.length ? (
        <select
          className={`meta-reviewer ${task.reviewerId ? 'set' : ''}`}
          value={task.reviewerId ?? ''}
          onChange={(e) => setTaskMeta(taskId, { reviewerId: e.target.value || undefined })}
          title="Reviewer — signs off on this task"
        >
          <option value="">＋reviewer</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>reviewer · {m.name}</option>
          ))}
        </select>
      ) : showReview && reviewerName ? (
        <Chip kind="owner">reviewer · {reviewerName}</Chip>
      ) : null}
      {editable && task.status === 'in_review' ? (
        <button type="button" className="meta-approve" title="Approve — mark done" onClick={() => setTaskMeta(taskId, { status: 'done' })}>
          Approve
        </button>
      ) : null}
      {approverName && task.status === 'done' ? <Chip kind="owner">approved · {approverName}</Chip> : null}
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
