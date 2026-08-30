// The table layout of the work view (NOTES_SPLIT_PLAN §N2, §I.3).
//
// Cells are display-only. Clicking one opens the shared TaskActionMenu scoped to that field, which
// is how a table can be edited without there being a bespoke editor per column. Clicking the TITLE
// opens the task instead — that asymmetry is what keeps "a row is a label plus one destination"
// true inside a table.

import { useMemo, useState } from 'react';
import { STATUS_LABEL } from '../StatusControl';
import { QuickAdd } from '../common/QuickAdd';
import { formatDateChip, todayISO } from '../../util/dates';
import type { FocusField } from '../../tasks/actions';
import { COLUMNS, type ColumnDef } from './workColumns';
import type { Group, Sort, SortKey } from './workView';
import type { ID, Member, Sprint, Task } from '../../types';

export function WorkTable({
  tabId, groups, sort, onSort, selection, onSelect, onOpenMenu, onOpenTask, canReorder, onReorder,
  members, sprints, tasksById, editable, nesting,
}: {
  tabId: ID;
  groups: Group[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  selection: Set<ID>;
  onSelect: (id: ID, mode: 'toggle' | 'range' | 'only') => void;
  onOpenMenu: (ids: ID[], x: number, y: number, field?: FocusField) => void;
  onOpenTask: (id: ID) => void;
  /**
   * Nesting is only shown when the rows on screen are a contiguous outline — no grouping, rank
   * order. Under any other arrangement a child can appear with its parent nowhere above it, and an
   * indent would be pointing at nothing. That is the same reason the old List used a crumb when
   * grouped by status and indentation only in outline mode.
   */
  nesting: {
    depthOf: (id: ID) => number;
    hasChildren: (id: ID) => boolean;
    isCollapsed: (id: ID) => boolean;
    toggle: (id: ID) => void;
  } | null;
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
      case 'status': return (
        <span className="wt-status">
          <span className={`list-dot status-${t.status ?? 'todo'}`} />
          <span className="wt-mono">{STATUS_LABEL[t.status ?? 'todo']}</span>
        </span>
      );
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
              const depth = nesting ? nesting.depthOf(t.id) : 0;
              const kids = nesting ? nesting.hasChildren(t.id) : false;
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

                  <span
                    className="wt-title-cell"
                    style={depth ? { paddingLeft: depth * 18 } : undefined}
                  >
                    {nesting && (kids
                      ? (
                        <button
                          type="button"
                          className={`wt-twisty ${nesting.isCollapsed(t.id) ? 'is-closed' : ''}`}
                          aria-label={nesting.isCollapsed(t.id) ? 'Show sub-tasks' : 'Hide sub-tasks'}
                          aria-expanded={!nesting.isCollapsed(t.id)}
                          onClick={() => nesting.toggle(t.id)}
                        >
                          <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden>
                            <path d="M5 3l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )
                      : <span className="wt-twisty is-leaf" aria-hidden />)}
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

      {/* The add line is the last ROW, not a field floating above the table: it is where the next
          task will actually appear, so that is where you type it. */}
      {editable && (
        <div className="wt-row is-add" role="row">
          <span className="wt-cb" />
          <QuickAdd tabId={tabId} shortcut />
        </div>
      )}
    </div>
  );
}
