// Kanban view: status columns over the same task entities. Drag a card to another column to change
// its status. Cards within a column sit in OUTLINE order (SUBTASKS_PLAN D4) — the board's one true
// order, so a family clusters together inside a column instead of scattering. There is deliberately
// no within-column reordering: position in a column is a property of the tree, not of the column.
// The "In review" column is highlighted to surface the accountability sign-off step.
//
// The scope switch (SUBTASKS_PLAN D10) is the escape hatch for a busy board: a parent with eight
// sub-tasks puts nine cards on the wall. "All work" is the default because children being invisible
// is the problem this whole change exists to fix; "Commitments" hides sub-task cards and leaves the
// deliverables, each still carrying its roll-up strip so nothing is actually lost. Remembered per
// board per user - the right scope is a property of how busy that particular board is.

import { useEffect, useMemo, useState } from 'react';
import { useBoardOutline, useStore } from '../store';
import { STATUS_LABEL } from './StatusControl';
import { TaskCard } from './common/TaskCard';
import type { Task, TaskStatus } from '../types';

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

type Scope = 'all' | 'roots';
const SCOPE_KEY = (tabId: string) => `tw:kanban-scope:${tabId}`;

export function BoardKanban({ tabId }: { tabId: string }) {
  // Outline order in, outline order out: bucketing preserves it, so each column shows its cards
  // in the board's one true order and families stay adjacent.
  const { list: tasks } = useBoardOutline(tabId);
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY(tabId)) === 'roots' ? 'roots' : 'all';
    } catch {
      return 'all';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY(tabId), scope);
    } catch {
      /* private mode / storage disabled — the choice just doesn't persist */
    }
  }, [tabId, scope]);

  const visible = useMemo(() => (scope === 'roots' ? tasks.filter((t) => !t.parentTaskId) : tasks), [tasks, scope]);
  const subtaskCount = tasks.length - visible.length;

  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const c of COLUMNS) m.set(c, []);
    for (const t of visible) {
      const s = (t.status ?? 'todo') as TaskStatus;
      if (m.has(s)) m.get(s)!.push(t);
    }
    return m;
  }, [visible]);

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
    <>
      <div className="kb-scope" role="tablist" aria-label="Card scope">
        <button
          role="tab"
          aria-selected={scope === 'all'}
          className={`list-mode ${scope === 'all' ? 'is-on' : ''}`}
          title="Every task, sub-tasks included"
          onClick={() => setScope('all')}
        >
          All work
        </button>
        <button
          role="tab"
          aria-selected={scope === 'roots'}
          className={`list-mode ${scope === 'roots' ? 'is-on' : ''}`}
          title="Only top-level tasks; sub-tasks stay visible as progress on their parent"
          onClick={() => setScope('roots')}
        >
          Commitments
        </button>
        {scope === 'roots' && subtaskCount > 0 && (
          <span className="kb-scope-note muted">{subtaskCount} sub-task{subtaskCount === 1 ? '' : 's'} hidden</span>
        )}
      </div>
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
                  expandable={scope === 'roots'}
                  onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
      </div>
    </>
  );
}
