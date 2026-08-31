// The table layout of the work view (NOTES_SPLIT_PLAN §N2, §I.3).
//
// Cells are display-only. Clicking one opens the shared TaskActionMenu scoped to that field, which
// is how a table can be edited without there being a bespoke editor per column. Clicking the TITLE
// opens the task instead — that asymmetry is what keeps "a row is a label plus one destination"
// true inside a table.

import { useCallback, useMemo, useRef, useState } from 'react';
import { STATUS_LABEL } from '../StatusControl';
import { QuickAdd } from '../common/QuickAdd';
import { useTableCursor } from './useTableCursor';
import { useStore } from '../../store';
import { focusQuickAdd } from '../../tasks/quickAddFocus';
import { formatDateChip, todayISO } from '../../util/dates';
import type { FocusField } from '../../tasks/actions';
import { COL, COLUMNS, columnAt, type ColumnDef } from './workColumns';
import type { Group, Sort, SortKey } from './workView';
import type { ID, Member, Sprint, Task } from '../../types';

export function WorkTable({
  tabId, groups, sort, onSort, selection, onSelect, onSelectAll, onOpenMenu, onOpenTask, canReorder, onReorder,
  onNest, onUnnest, onDelete, members, sprints, tasksById, editable, nesting,
}: {
  tabId: ID;
  groups: Group[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  selection: Set<ID>;
  onSelect: (id: ID, mode: 'toggle' | 'range' | 'only') => void;
  onOpenMenu: (ids: ID[], x: number, y: number, field?: FocusField) => void;
  onOpenTask: (id: ID) => void;
  /** Tri-state over the rows on screen: select all of them, or clear the selection. */
  onSelectAll: (select: boolean) => void;
  /**
   * Nesting is only shown when the rows on screen are a contiguous outline — no grouping, rank
   * order. Under any other arrangement a child can appear with its parent nowhere above it, and an
   * indent would be pointing at nothing. That is the same reason the old List used a crumb when
   * grouped by status and indentation only in outline mode.
   */
  onNest: (id: ID) => void;
  onUnnest: (id: ID) => void;
  onDelete: (id: ID) => void;
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
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<ID | null>(null);
  const [renaming, setRenaming] = useState<{ id: ID; text: string } | null>(null);
  const flatIds = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups]);

  /** Open the menu over a cell the KEYBOARD chose, so it lands on the cell rather than the pointer. */
  const openCellByIndex = useCallback((taskId: ID, col: number) => {
    const el = rootRef.current?.querySelector(`[data-row="${CSS.escape(taskId)}"] [data-col="${col}"]`);
    const box = el?.getBoundingClientRect();
    onOpenMenu([taskId], box?.left ?? 0, (box?.bottom ?? 0) + 4, columnAt(col)?.field);
  }, [onOpenMenu]);

  /** Click and keyboard both land here, so a rename begins the same way whichever started it. */
  const startRename = useCallback((id: ID, seed?: string) => {
    setRenaming({ id, text: seed ?? useStore.getState().tasks[id]?.text ?? '' });
  }, []);

  const { cursor, setCursor, onKeyDown } = useTableCursor(
    flatIds,
    {
      openCell: openCellByIndex,
      renameStart: startRename,
      openTask: onOpenTask,
      toggleSelect: (id) => onSelect(id, 'toggle'),
      nest: onNest,
      unnest: onUnnest,
      remove: onDelete,
      focusAdd: () => focusQuickAdd(tabId),
    },
    editable,
    rootRef,
  );

  /**
   * Put the cursor where the pointer went AND give the table the keyboard. Nothing used to focus
   * the container, so its key handler never ran and the whole cursor was unreachable
   * (TABLE_EDITING_PLAN §0). Not relying on the clicked button taking focus: Safari does not focus
   * buttons on click, so it has to be explicit.
   */
  const putCursor = useCallback((row: ID, col: number) => {
    setCursor({ row, col });
    rootRef.current?.focus({ preventScroll: true });
  }, [setCursor]);

  const allOnScreen = flatIds.length > 0 && flatIds.every((id) => selection.has(id));
  const someOnScreen = flatIds.some((id) => selection.has(id));

  const commitRename = (): void => {
    if (!renaming) return;
    const text = renaming.text.trim();
    // An emptied title is an editing state, not a value — the same rule the board title follows.
    if (text) useStore.getState().setTaskText(renaming.id, text);
    setRenaming(null);
  };
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
    <div
      className="work-table"
      role="grid"
      aria-label="Tasks"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={(e) => { if (!renaming) onKeyDown(e); }}
    >
      <div className="wt-head" role="row">
        {/* A header of its own for column one. Without it `TITLE` was the leftmost label and read
            as naming the checkbox column too — and a table with a bulk bar should have had
            select-all from the start (§T3). */}
        <span className="wt-cb">
          {editable && (
            <input
              type="checkbox"
              checked={allOnScreen}
              ref={(el) => { if (el) el.indeterminate = someOnScreen && !allOnScreen; }}
              aria-label={allOnScreen ? 'Clear selection' : 'Select all tasks shown'}
              onChange={() => onSelectAll(!allOnScreen)}
            />
          )}
        </span>
        <button type="button" className={`wt-th ${sort.key === 'title' ? 'is-sorted' : ''}`} onClick={() => onSort('title')}>
          Title{sort.key === 'title' && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
        </button>
        {COLUMNS.map((c) => (
          <button key={c.key} type="button" className={`wt-th ${sort.key === c.key ? 'is-sorted' : ''}`} onClick={() => onSort(c.key)}>
            {c.label}{sort.key === c.key && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
          </button>
        ))}
        <span className="wt-th">Parent</span>
        <span className="wt-th wt-open-th" aria-hidden />
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
                  aria-selected={selection.has(t.id)}
                  data-row={t.id}
                  className={`wt-row ${selection.has(t.id) ? 'is-selected' : ''} ${done ? 'is-done' : ''} ${cursor?.row === t.id ? 'is-cursor' : ''}`}
                  data-drop={dropOn?.id === t.id ? dropOn.place : undefined}
                  onMouseDown={() => putCursor(t.id, COL.title)}
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
                  <span
                    className={`wt-cb ${cursor?.row === t.id && cursor.col === COL.select ? 'is-focused' : ''}`}
                    data-col={COL.select}
                  >
                    {editable && (
                      <input
                        type="checkbox"
                        checked={selection.has(t.id)}
                        aria-label={`Select ${t.text || 'task'}`}
                        onChange={() => undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          putCursor(t.id, COL.select);
                          onSelect(t.id, e.shiftKey ? 'range' : 'toggle');
                        }}
                      />
                    )}
                  </span>

                  <span
                    className={`wt-title-cell ${cursor?.row === t.id && cursor.col === COL.title ? 'is-focused' : ''}`}
                    data-col={COL.title}
                    style={depth ? { paddingLeft: depth * 18 } : undefined}
                  >
                    {/* A sub-task says so at the far left, so it reads as nested even where the
                        indent alone is ambiguous — a long title, a narrow window, a phone. */}
                    {depth > 0 && (
                      <svg className="wt-sub-mark" viewBox="0 0 16 16" width="11" height="11" aria-label="sub-task">
                        <path d="M4 2v6.5a2 2 0 0 0 2 2h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
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
                    {renaming?.id === t.id ? (
                      <input
                        className="wt-title-input"
                        value={renaming.text}
                        autoFocus
                        aria-label="Task title"
                        onChange={(e) => setRenaming({ id: t.id, text: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                          e.stopPropagation(); // the table's own keys must not fire while typing
                        }}
                      />
                    ) : (
                      /* Not a link any more. A click parks the cursor here; a second click, a
                         double-click, Enter, or simply typing starts the rename. Opening the task
                         is the arrow at the end of the row, and only that (§T2). */
                      <button
                        type="button"
                        className="wt-title"
                        title="Click to edit"
                        onClick={() => {
                          if (cursor?.row === t.id && cursor.col === COL.title) startRename(t.id);
                          else putCursor(t.id, COL.title);
                        }}
                        onDoubleClick={() => startRename(t.id)}
                      >
                        {t.text || <em className="muted">(empty)</em>}
                      </button>
                    )}
                  </span>

                  {COLUMNS.map((c, ci) => (
                    <button
                      key={c.key}
                      type="button"
                      data-col={COL.fieldFirst + ci}
                      className={`wt-cell ${cursor?.row === t.id && cursor.col === COL.fieldFirst + ci ? 'is-focused' : ''}`}
                      disabled={!editable || !c.field}
                      onClick={(e) => {
                        putCursor(t.id, COL.fieldFirst + ci);
                        const ids = selection.has(t.id) ? [...selection] : [t.id];
                        const box = e.currentTarget.getBoundingClientRect();
                        onOpenMenu(ids, box.left, box.bottom + 4, c.field);
                      }}
                    >
                      {cell(t, c)}
                    </button>
                  ))}

                  {/* Text, not a link: the arrow is the only way out of a row, a parent included. */}
                  <span
                    className={`wt-cell is-static ${cursor?.row === t.id && cursor.col === COL.parent ? 'is-focused' : ''}`}
                    data-col={COL.parent}
                  >
                    <span className={`wt-mono ${parent ? '' : 'muted'}`}>{parent ? parent.text || '(untitled)' : '—'}</span>
                  </span>

                  <button
                    type="button"
                    data-col={COL.open}
                    className={`wt-cell wt-open ${cursor?.row === t.id && cursor.col === COL.open ? 'is-focused' : ''}`}
                    aria-label="Open task"
                    title="Open task"
                    onClick={() => { putCursor(t.id, COL.open); onOpenTask(t.id); }}
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                      <path d="M6 3h7v7M13 3L4 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* The add line is the last ROW, not a field floating above the table: it is where the next
          task will actually appear, so that is where you type it. */}
      {editable && (
        <div
          className={`wt-row is-add ${cursor?.row === 'add' ? 'is-cursor' : ''}`}
          role="row"
          data-add-row
        >
          <span className="wt-cb" />
          <QuickAdd tabId={tabId} shortcut />
        </div>
      )}
    </div>
  );
}
