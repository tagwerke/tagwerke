// List view: the board's tasks grouped by status, collapsible sections, one TaskRow each.
// A pure projection of the same task entities the doc edits — status/assignee/date edits here
// write straight through the store (and sync back into the doc). No new data.

import { useMemo, useState } from 'react';
import { useTasksForTab } from '../store';
import { STATUS_ORDER, STATUS_LABEL } from './StatusControl';
import { TaskRow } from './common/TaskRow';
import type { Task, TaskStatus } from '../types';

export function BoardList({ tabId }: { tabId: string }) {
  const tasks = useTasksForTab(tabId);
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(new Set());

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) m.set(s, []);
    for (const t of tasks) m.get(t.status ?? 'todo')!.push(t);
    for (const s of STATUS_ORDER) m.get(s)!.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return m;
  }, [tasks]);

  const toggle = (s: TaskStatus) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });

  if (tasks.length === 0) {
    return <div className="view-placeholder muted">No tasks yet. Add them in the Doc view — they show up here grouped by status.</div>;
  }

  return (
    <div className="board-list">
      {STATUS_ORDER.map((s) => {
        const items = byStatus.get(s)!;
        if (!items.length) return null;
        const isCollapsed = collapsed.has(s);
        return (
          <section className="list-group" key={s}>
            <button className="list-group-head" onClick={() => toggle(s)}>
              <span className={`list-caret ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
              <span className={`list-dot status-${s}`} />
              <span className="list-group-name">{STATUS_LABEL[s]}</span>
              <span className="list-group-n">{items.length}</span>
            </button>
            {!isCollapsed && (
              <div className="list-rows">
                {items.map((t) => <TaskRow key={t.id} taskId={t.id} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
