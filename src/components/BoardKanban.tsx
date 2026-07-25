// Kanban view: status columns over the same task entities. Drag a card to another column to change
// its status. Cards within a column sit in OUTLINE order (SUBTASKS_PLAN D4) — the board's one true
// order, so a family clusters together inside a column instead of scattering. There is deliberately
// no within-column reordering: position in a column is a property of the tree, not of the column.
// The "In review" column is highlighted to surface the accountability sign-off step.

import { useMemo, useState } from 'react';
import { useBoardOutline, useStore } from '../store';
import { STATUS_LABEL } from './StatusControl';
import { TaskCard } from './common/TaskCard';
import type { Task, TaskStatus } from '../types';

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export function BoardKanban({ tabId }: { tabId: string }) {
  // Outline order in, outline order out: bucketing preserves it, so each column shows its cards
  // in the board's one true order and families stay adjacent.
  const { list: tasks } = useBoardOutline(tabId);
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const c of COLUMNS) m.set(c, []);
    for (const t of tasks) {
      const s = (t.status ?? 'todo') as TaskStatus;
      if (m.has(s)) m.get(s)!.push(t);
    }
    return m;
  }, [tasks]);

  const drop = (status: TaskStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/task');
    if (!id) return;
    // Status only. A card's place in a column comes from its position in the tree (SUBTASKS_PLAN
    // D4) — there is one order across every view, and dropping into a column doesn't reorder it.
    setTaskMeta(id, { status });
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
