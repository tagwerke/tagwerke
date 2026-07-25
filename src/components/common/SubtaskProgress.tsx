// Sub-task roll-up on a parent row (SUBTASKS_PLAN P5). Segmented by STATUS, not a plain done/total
// fraction — with five states, "0/3" reads as "nothing is happening" on a deliverable where two
// people are mid-flight. The strip says what is actually true at a glance, which is the point:
// a parent's own status is never derived (D5), so this is what keeps the row honest.
//
// Derived entirely client-side. `assembleState` already ships every task of every visible board, so
// there is no count to denormalize and nothing to keep in sync.

import { useMemo } from 'react';
import { useStore, subtaskStats } from '../../store';
import { STATUS_LABEL } from '../StatusControl';
import type { ID, TaskStatus } from '../../types';

// Left-to-right: finished work first, unstarted last, so the bar fills as the deliverable advances.
const SEGMENTS: TaskStatus[] = ['done', 'in_review', 'in_progress', 'todo', 'cancelled'];

export function SubtaskProgress({ taskId, className = '' }: { taskId: ID; className?: string }) {
  const tasks = useStore((s) => s.tasks);
  const stats = useMemo(() => subtaskStats(tasks, taskId), [tasks, taskId]);
  if (!stats.total) return null;

  const title = SEGMENTS.filter((s) => stats.byStatus[s] > 0)
    .map((s) => `${stats.byStatus[s]} ${STATUS_LABEL[s].toLowerCase()}`)
    .join(', ');

  return (
    <span className={`subtask-progress ${className}`} title={`${stats.total} sub-tasks — ${title}`}>
      <span className="subtask-bar" aria-hidden>
        {SEGMENTS.map((s) =>
          stats.byStatus[s] ? (
            <span
              key={s}
              className={`subtask-seg status-${s}`}
              style={{ flexGrow: stats.byStatus[s] }}
            />
          ) : null,
        )}
      </span>
      <span className="subtask-count">
        {stats.done}/{stats.total}
      </span>
    </span>
  );
}
