// The table layout of the work view (NOTES_SPLIT_PLAN §N2, §I.3).
//
// Cells are display-only. Clicking one opens the shared TaskActionMenu scoped to that field, which
// is how a table can be edited without there being a bespoke editor per column. Clicking the TITLE
// opens the task instead — that asymmetry is what keeps "a row is a label plus one destination"
// true inside a table.

import { useMemo, useState } from 'react';
import { StatusControl, STATUS_LABEL } from '../StatusControl';
import { formatDateChip, todayISO } from '../../util/dates';
import type { FocusField } from '../../tasks/actions';
import { COLUMNS, type ColumnDef } from './workColumns';
import type { Group, Sort, SortKey } from './workView';
import type { ID, Member, Sprint, Task, TaskStatus } from '../../types';

export function WorkTable({
  groups, sort, onSort, selection, onSelect, onOpenMenu, onOpenTask, onToggleDone, onPickStatus, canReorder, onReorder,
  members, sprints, tasksById, editable,
}: {
  groups: Group[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  selection: Set<ID>;
  onSelect: (id: ID, mode: 'toggle' | 'range' | 'only') => void;
  onOpenMenu: (ids: ID[], x: number, y: number, field?: FocusField) => void;
  onOpenTask: (id: ID) => void;
  onToggleDone: (id: ID) => void;
  onPickStatus: (id: ID, status: TaskStatus) => void;
  /** Reordering is meaningful only in rank order (§I.3); otherwise the handle is not drawn. */
  canReorder: boolean;
  onReorder: (dragId: ID, targetId: ID, place: 'before' | 'after') => void;
  members: Member[];
  sprints: Sprint[];
  tasksById: Record<ID, Task>;
  editable: boolean;
}) {
  const [dragId, setDragId] = useState<ID | null>(null);
  const [dropOn, setDropOn] = useState<{ id: ID; place: 'before' | 'after' } | null>(null);
  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const sprintName = useMemo(() => new Map(sprints.map((s) => [s.id, s.label])), [sprints]);
  const today = todayISO();

  const cell = (t: Task, col: ColumnDef): React.ReactNode => {
    switch (col.key) {
      case 'status': return <span className="wt-mono">{STATUS_LABEL[t.status ?? 'todo']}</span>;
      case 'assignee': return <span className="wt-mono">{t.assigneeId ? memberName.get(t.assigneeId) ?? '—' : '—'}</span>;
      case 'due': {
        if (!t.date) return <span className="wt-mono muted">—</span>;
        const active = t.status !== 'done' && t.status !== 'cancelled';
        return <span className={`wt-mono ${active && t.date < today ? 'is-overdue' : ''}`}>{formatDateChip(t.date)}</span>;
      }
      case 'priority': return <span className="wt-mono">{t.priority ? '!'.repeat(t.priority) : '—'}</span>;
      case 'sprint': return <span className="wt-mono">{t.sprintId ? sprintName.get(t.sprintId) ?? '—' : 'Backlog'}</span>;
      default: return null;
    }
  };

  return (
    <div className="work-table" role="table">
      <div className="wt-head" role="row">
        <span className="wt-cb" />
        <button type="button" className={`wt-th ${sort.key === 'title' ? 'is-sorted' : ''}`} onClick={() => onSort('title')}>
          Title{sort.key === 'title' && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
        </button>
        {COLUMNS.map((c) => (
          <button key={c.key} type="button" className={`wt-th ${sort.key === c.key ? 'is-sorted' : ''}`} onClick={() => onSort(c.key)}>
            {c.label}{sort.key === c.key && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
          </button>
        ))}
        <span className="wt-th">Parent</span>
      </div>

      {groups.map((g) => {
        if (!g.tasks.length) return null; // an empty group is a column in the board layout, not a row here
        return (
          <div key={g.key} className="wt-group">
            <div className="wt-group-head" role="row">
              {g.swatch && <span className={`list-dot ${g.swatch}`} />}
              <span>{g.label}</span>
              <span className="wt-group-n">{g.tasks.length}</span>
            </div>
            {g.tasks.map((t) => {
              const parent = t.parentTaskId ? tasksById[t.parentTaskId] : undefined;
              const done = t.status === 'done' || t.status === 'cancelled';
              return (
                <div
                  key={t.id}
                  role="row"
                  className={`wt-row ${selection.has(t.id) ? 'is-selected' : ''} ${done ? 'is-done' : ''}`}
                  data-drop={dropOn?.id === t.id ? dropOn.place : undefined}
                  draggable={canReorder && editable}
                  onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { setDragId(null); setDropOn(null); }}
                  onDragOver={(e) => {
                    if (!dragId || dragId === t.id) return;
                    // Only among true siblings in the same group: rankBetween is only meaningful
                    // between two tasks that share a parent, and a cross-group drop would need to
                    // change the grouping field as well, which is what the board layout is for.
                    const drag = tasksById[dragId];
                    if (!drag || (drag.parentTaskId ?? null) !== (t.parentTaskId ?? null)) return;
                    if (!g.tasks.some((x) => x.id === dragId)) return;
                    e.preventDefault();
                    const box = e.currentTarget.getBoundingClientRect();
                    setDropOn({ id: t.id, place: e.clientY < box.top + box.height / 2 ? 'before' : 'after' });
                  }}
                  onDragLeave={() => setDropOn((d) => (d?.id === t.id ? null : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dropOn?.id === t.id) onReorder(dragId, t.id, dropOn.place);
                    setDragId(null);
                    setDropOn(null);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const ids = selection.has(t.id) ? [...selection] : [t.id];
                    onOpenMenu(ids, e.clientX, e.clientY);
                  }}
                >
                  <span className="wt-cb">
                    {editable && (
                      <input
                        type="checkbox"
                        checked={selection.has(t.id)}
                        aria-label={`Select ${t.text || 'task'}`}
                        onChange={() => undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(t.id, e.shiftKey ? 'range' : 'toggle');
                        }}
                      />
                    )}
                  </span>

                  <span className="wt-title-cell">
                    <StatusControl
                      status={t.status ?? 'todo'}
                      disabled={!editable}
                      onToggle={() => onToggleDone(t.id)}
                      onPick={(s) => onPickStatus(t.id, s)}
                    />
                    <button type="button" className="wt-title" onClick={() => onOpenTask(t.id)} title="Open task">
                      {t.text || <em className="muted">(empty)</em>}
                    </button>
                  </span>

                  {COLUMNS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      className="wt-cell"
                      disabled={!editable || !c.field}
                      onClick={(e) => {
                        const ids = selection.has(t.id) ? [...selection] : [t.id];
                        const box = e.currentTarget.getBoundingClientRect();
                        onOpenMenu(ids, box.left, box.bottom + 4, c.field);
                      }}
                    >
                      {cell(t, c)}
                    </button>
                  ))}

                  <span className="wt-cell is-static">
                    {parent
                      ? <button type="button" className="wt-parent" onClick={() => onOpenTask(parent.id)}>{parent.text || '(empty)'}</button>
                      : <span className="wt-mono muted">—</span>}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
