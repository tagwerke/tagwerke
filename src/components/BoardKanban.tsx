// Kanban view: status columns over the same task entities. Drag a card to another column to
// change its status (it appends to the end via `position`, which is already modeled + persisted).
// Fine-grained within-column reordering is a later refinement. The "In review" column is
// highlighted to surface the accountability sign-off step.

import { useMemo, useState } from 'react';
import { useTasksForTab, useStore } from '../store';
import { STATUS_LABEL } from './StatusControl';
import { TaskCard } from './common/TaskCard';
import type { Task, TaskStatus } from '../types';

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export function BoardKanban({ tabId }: { tabId: string }) {
  const tasks = useTasksForTab(tabId);
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const c of COLUMNS) m.set(c, []);
    for (const t of tasks) {
      const s = (t.status ?? 'todo') as TaskStatus;
      if (m.has(s)) m.get(s)!.push(t);
    }
    for (const c of COLUMNS) m.get(c)!.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return m;
  }, [tasks]);

  const drop = (status: TaskStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/task');
    if (!id) return;
    const col = byStatus.get(status)!;
    const maxPos = col.reduce((mx, t) => Math.max(mx, t.position ?? 0), -1);
    setTaskMeta(id, { status, position: maxPos + 1 });
  };

  return (
    <div className="board-kanban">
      {COLUMNS.map((status) => {
        const items = byStatus.get(status)!;
        return (
          <section
            key={status}
            className={`kb-col ${status === 'in_review' ? 'is-review' : ''} ${dragOver === status ? 'is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(status); }}
            onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
            onDrop={drop(status)}
          >
            <header className="kb-col-head">
              <span className={`list-dot status-${status}`} />
              <span className="kb-col-name">{STATUS_LABEL[status]}</span>
              <span className="kb-col-n">{items.length}</span>
            </header>
            <div className="kb-col-stack">
              {items.map((t) => (
                <TaskCard
                  key={t.id}
                  taskId={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
