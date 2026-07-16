// A meeting's agenda: the linked board's LIVE tasks, narrowed by the event's BlockFilter.
// Never the whole board — link + filter, the same live-projection the Planner used. Read-only
// here (full task editing happens on the board).

import { useMemo } from 'react';
import { useTasksForTab } from '../../store';
import { matchesBlockFilter } from '../../util/filter';
import { PlannerTaskLine } from '../planner/PlannerTaskLine';
import type { BlockFilter, ID } from '../../types';

const MAX_LINES = 8;

export function AgendaList({ tabId, filter }: { tabId: ID; filter?: BlockFilter | null }) {
  const allTasks = useTasksForTab(tabId);
  const tasks = useMemo(
    () => allTasks.filter((t) => matchesBlockFilter(t, filter)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [allTasks, filter],
  );

  return (
    <ul className="cal-agenda">
      {tasks.length === 0 && <li className="cal-agenda-empty muted">no matching tasks</li>}
      {tasks.slice(0, MAX_LINES).map((t) => (
        <PlannerTaskLine key={t.id} taskId={t.id} readOnly />
      ))}
      {tasks.length > MAX_LINES && <li className="cal-agenda-more muted">+{tasks.length - MAX_LINES} more on the board</li>}
    </ul>
  );
}
