// Sub-task roll-up on a parent row (SUBTASKS_PLAN P5). Segmented by STATUS, not a plain done/total
// fraction — with several states, "0/3" reads as "nothing is happening" on a deliverable where two
// people are mid-flight. The strip says what is actually true at a glance, which is the point:
// a parent's own status is never derived (D5), so this is what keeps the row honest.
//
// Derived entirely client-side. `assembleState` already ships every task of every visible board, so
// there is no count to denormalize and nothing to keep in sync.

import { useMemo } from 'react';
import { useStore, subtaskStats } from '../../store';
import { stateIn, stateStyle, useBoardStates } from '../../tasks/states';
import type { StatusCategory } from '../../../shared/status';
import type { ID } from '../../types';

// Left-to-right: finished work first, unstarted last, so the bar fills as the deliverable advances.
// Within a category, the board's own order.
const CATEGORY_ORDER: StatusCategory[] = ['done', 'waiting', 'active', 'open', 'closed'];

export function SubtaskProgress({ taskId, className = '' }: { taskId: ID; className?: string }) {
  const tasks = useStore((s) => s.tasks);
  // Sub-tasks live on their parent's board (tasks_parent_same_board), so its states cover them all.
  const states = useBoardStates(tasks[taskId]?.homeTabId);
  const stats = useMemo(() => subtaskStats(tasks, taskId, states), [tasks, taskId, states]);
  if (!stats.total) return null;

  const segments = Object.keys(stats.byStatus)
    .map((key) => stateIn(states, key))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.position - b.position);
  const title = segments.map((s) => `${stats.byStatus[s.key]} ${s.label.toLowerCase()}`).join(', ');

  return (
    <span className={`subtask-progress ${className}`} title={`${stats.total} sub-tasks — ${title}`}>
      <span className="subtask-bar" aria-hidden>
        {segments.map((s) => (
          <span key={s.key} className="subtask-seg" style={{ ...stateStyle(s), flexGrow: stats.byStatus[s.key] }} />
        ))}
      </span>
      <span className="subtask-count">
        {stats.done}/{stats.total}
      </span>
    </span>
  );
}
