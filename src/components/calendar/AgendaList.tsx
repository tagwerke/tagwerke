// A meeting's agenda: the linked board's LIVE tasks, narrowed by the event's BlockFilter.
// Never the whole board — link + filter, the same live-projection the Planner used. Read-only
// here (full task editing happens on the board).

import { useMemo } from 'react';
import { useBoardOutline } from '../../store';
import { matchesBlockFilter } from '../../util/filter';
import { TaskRow } from '../common/TaskRow';
import { boardTaskPath, navigate } from '../../util/router';
import type { BlockFilter, ID } from '../../types';

const MAX_LINES = 8;

export function AgendaList({ tabId, filter }: { tabId: ID; filter?: BlockFilter | null }) {
  // Already in the board's outline order, so filtering preserves it — no sort needed.
  const { list: allTasks } = useBoardOutline(tabId);
  const tasks = useMemo(() => allTasks.filter((t) => matchesBlockFilter(t, filter)), [allTasks, filter]);

  return (
    <ul className="cal-agenda">
      {tasks.length === 0 && <li className="cal-agenda-empty muted">no matching tasks</li>}
      {tasks.slice(0, MAX_LINES).map((t) => (
        <TaskRow key={t.id} taskId={t.id} editable={false} onOpen={() => navigate(boardTaskPath(tabId, t.id))} />
      ))}
      {tasks.length > MAX_LINES && <li className="cal-agenda-more muted">+{tasks.length - MAX_LINES} more on the board</li>}
    </ul>
  );
}
