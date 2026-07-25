// List view: the board's tasks, either grouped by STATUS (the default — collapsible sections, one
// TaskRow each) or as an OUTLINE (SUBTASKS_PLAN P5). A pure projection of the same task entities
// the doc edits — status/assignee/date edits here write straight through the store. No new data.
//
// The two modes exist because sub-tasks can only be shown one of two ways, and which one works
// depends on what the view is grouped by:
//   status  — a parent and its child routinely land in different sections, so indentation would be
//             a lie (there is nothing above the child to indent from). The `Parent ›` crumb carries
//             the relationship instead, and holds no matter which section a task falls into.
//   outline — order IS the tree, so indentation says it directly and no crumb is needed. This is
//             the view that answers "what is the shape of this board".

import { useMemo, useState } from 'react';
import { useBoardOutline, taskDepth, useStore } from '../store';
import { STATUS_ORDER, STATUS_LABEL } from './StatusControl';
import { TaskRow } from './common/TaskRow';
import type { Task, TaskStatus } from '../types';

type Grouping = 'status' | 'outline';

const MODES: { key: Grouping; label: string; hint: string }[] = [
  { key: 'status', label: 'Status', hint: 'Group by status' },
  { key: 'outline', label: 'Outline', hint: 'The board’s structure, sub-tasks indented under their parent' },
];

export function BoardList({ tabId }: { tabId: string }) {
  const { list: tasks } = useBoardOutline(tabId);
  const allTasks = useStore((s) => s.tasks);
  const [grouping, setGrouping] = useState<Grouping>('status');
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(new Set());

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) m.set(s, []);
    for (const t of tasks) m.get(t.status ?? 'todo')!.push(t);
    return m;
  }, [tasks]);

  const toggle = (s: TaskStatus) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  if (tasks.length === 0) {
    return <div className="view-placeholder muted">No tasks yet. Add them in the Doc view — they show up here grouped by status.</div>;
  }

  return (
    <div className="board-list">
      <div className="list-modes" role="tablist" aria-label="Group by">
        {MODES.map((m) => (
          <button
            key={m.key}
            role="tab"
            aria-selected={grouping === m.key}
            className={`list-mode ${grouping === m.key ? 'is-on' : ''}`}
            title={m.hint}
            onClick={() => setGrouping(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {grouping === 'outline' ? (
        <div className="list-rows list-outline">
          {tasks.map((t) => (
            <TaskRow key={t.id} taskId={t.id} indent={taskDepth(allTasks, t.id)} />
          ))}
        </div>
      ) : (
        STATUS_ORDER.map((s) => {
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
                  {items.map((t) => (
                    <TaskRow key={t.id} taskId={t.id} showParent />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
