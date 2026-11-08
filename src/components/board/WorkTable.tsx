// The table layout of the work view (NOTES_SPLIT_PLAN §N2, §I.3).
//
// Its columns are the board's (`tableColumns`, CUSTOM_FIELDS_PLAN P4), passed in as `columns`. A
// custom field's column shows the value, as a link where it is one, and an editor edits it in place:
// a click on the cell (not on the link), or Enter on it, opens an input; Enter or leaving it saves,
// Escape drops the change. Board admins rename, hide or delete a field's column from its header and
// add a new one from the + at the end of the header.
//
// Cells are display-only. Clicking one opens the shared TaskActionMenu scoped to that field, which
// is how a table can be edited without there being a bespoke editor per column. Clicking the TITLE
// opens the task instead — that asymmetry is what keeps "a row is a label plus one destination"
// true inside a table.

import { useCallback, useMemo, useRef, useState } from 'react';
import { QuickAdd } from '../common/QuickAdd';
import { useTableCursor } from './useTableCursor';
import { useStore } from '../../store';
import { focusQuickAdd } from '../../tasks/quickAddFocus';
import { formatDateChip, todayISO } from '../../util/dates';
import type { FocusField } from '../../tasks/actions';
import { COL, columnAt, gridOf, openCol, type ColumnDef } from './workColumns';
import { AddColumn, FieldColumnMenu } from './ColumnPopovers';
import { descriptionMatch } from './workFilters';
import type { BoardField, FieldValue } from '../../../shared/fields';
import { FIELD_INPUT_TYPE, fieldLink, invalidFieldMessage, parseFieldInput } from '../../tasks/fields';
import { showToast } from '../../toast/useToast';
import type { Group, Sort, SortKey } from './workView';
import type { DraftFields } from '../../tasks/createTask';
import type { ID, Member, Sprint, Task } from '../../types';
import { stateIn, stateStyle, useBoardStates } from '../../tasks/states';
import { isTerminal } from '../../../shared/status';

/** A touch screen: no hover and no double-click, so a tap on a title has to mean "open". */
const isTouch = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

export function WorkTable({
  tabId, groups, sort, onSort, selection, onSelect, onSelectAll, onOpenMenu, onOpenTask, canReorder, onReorder,
  onShift, onNest, onUnnest, onDelete, members, sprints, tasksById, editable, nesting, contextIds, addFields, onCreated,
  columns, columnIds, fieldCount, isAdmin, query,
}: {
  tabId: ID;
  /** The board's columns, in its order (workColumns.buildColumns). */
  columns: ColumnDef[];
  /** The same, as the ids the board stores: what a column write sends back. */
  columnIds: readonly string[];
  /** Live fields on the board, shown or not: the + refuses past MAX_FIELDS. */
  fieldCount: number;
  /** Admins manage columns from the header. */
  isAdmin: boolean;
  /** The search, so a row that matched on its description can say so. */
  query: string;
  groups: Group[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  selection: Set<ID>;
  onSelect: (id: ID, mode: 'toggle' | 'range' | 'only') => void;
  /** `onStep` is set for a cell's menu: ←/→ inside it leave for the neighbouring cell. */
  onOpenMenu: (ids: ID[], x: number, y: number, field?: FocusField, onStep?: (dir: -1 | 1) => void) => void;
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
  /** Alt+↑/↓: swap a task with its neighbouring sibling. */
  onShift: (id: ID, dir: -1 | 1) => void;
  members: Member[];
  sprints: Sprint[];
  tasksById: Record<ID, Task>;
  editable: boolean;
  /** Rows shown only because a descendant matched the filters — dimmed, and not selectable. */
  contextIds: ReadonlySet<ID>;
  /** What the add line starts a task as. Null hides the line: the filters name no single value. */
  addFields: DraftFields | null;
  onCreated: (id: ID) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<ID | null>(null);
  const [renaming, setRenaming] = useState<{ id: ID; text: string } | null>(null);
  /** The custom field being edited in place, if any. */
  const [fieldEdit, setFieldEdit] = useState<{ id: ID; key: string } | null>(null);
  const endingRef = useRef(false);
  const flatIds = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups]);

  const cellEl = (taskId: ID, col: number): Element | null | undefined =>
    rootRef.current?.querySelector(`[data-row="${CSS.escape(taskId)}"] [data-col="${col}"]`);

  /** Click and keyboard both land here, so a rename begins the same way whichever started it. */
  const startRename = useCallback((id: ID, seed?: string) => {
    setRenaming({ id, text: seed ?? useStore.getState().tasks[id]?.text ?? '' });
  }, []);

  const { cursor, setCursor, onKeyDown, moveRow, stepCol } = useTableCursor(
    flatIds,
    {
      openCell: (taskId, col) => openCellByIndex(taskId, col),
      renameStart: startRename,
      openTask: onOpenTask,
      toggleSelect: (id) => onSelect(id, 'toggle'),
      nest: onNest,
      unnest: onUnnest,
      shift: onShift,
      colVisible: (taskId, col) => {
        // Hidden by a narrow-width rule means no layout box at all.
        const el = cellEl(taskId, col);
        return !!el && el.getClientRects().length > 0;
      },
      remove: onDelete,
      focusAdd: () => focusQuickAdd(tabId),
    },
    editable,
    rootRef,
    openCol(columns),
    addFields !== null,
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

  /**
   * Open the menu over a cell, scoped to its field. ←/→ inside that menu step to the neighbouring
   * cell — and straight into its menu when it has one — so a row can be filled in field by field
   * without letting go of the keyboard. The menu used to swallow both keys, which is where "the
   * arrows don't move between fields" came from: after the first Enter, they didn't.
   */
  const openCellByIndex = (taskId: ID, col: number, ids: ID[] = [taskId]): void => {
    const box = cellEl(taskId, col)?.getBoundingClientRect();
    const column = columnAt(columns, col);
    if (column?.boardField) {
      if (editable) setFieldEdit({ id: taskId, key: column.boardField.key });
      return;
    }
    const field = column?.field;
    if (!field) return; // Parent is text: `↗` is the only way out of a row
    onOpenMenu(ids, box?.left ?? 0, (box?.bottom ?? 0) + 4, field, (dir) => {
      const next = stepCol(taskId, col, dir);
      putCursor(taskId, next);
      if (next !== col && columnAt(columns, next)?.field && editable) openCellByIndex(taskId, next, ids);
    });
  };

  /**
   * End an in-place field edit: `text` is what was typed, or null for Escape. A value the field's
   * type refuses is not saved, and says so. Enter and Escape give the keyboard back to the table;
   * leaving by a click does not, because the click went somewhere on purpose.
   */
  const endFieldEdit = (t: Task, field: BoardField, text: string | null, refocus: boolean): void => {
    setFieldEdit(null);
    if (text !== null) {
      const next = parseFieldInput(field.type, text);
      if (next === undefined) showToast(invalidFieldMessage(field));
      else if (next !== (t.fields?.[field.key] ?? null)) useStore.getState().setTaskField(t.id, field.key, next);
    }
    if (refocus) rootRef.current?.focus({ preventScroll: true });
  };

  /** The open header popover: a field column's menu, or the + that adds a column. */
  const [pop, setPop] = useState<{ kind: 'add'; anchor: DOMRect } | { kind: 'field'; field: BoardField; anchor: DOMRect } | null>(null);
  const closePop = useCallback(() => setPop(null), []);
  const grid = useMemo(() => gridOf(columns), [columns]);
  const last = openCol(columns);

  const selectable = useMemo(() => flatIds.filter((id) => !contextIds.has(id)), [flatIds, contextIds]);
  const allOnScreen = selectable.length > 0 && selectable.every((id) => selection.has(id));
  const someOnScreen = selectable.some((id) => selection.has(id));

  /**
   * End the rename and give the keyboard back to the table.
   *
   * The refocus is the whole point. Closing the input unmounts it, and focus falls to <body> —
   * so the table's key handler stopped receiving anything and the cursor appeared frozen. A blur
   * exit passes `refocus: false`, because there the user has deliberately clicked somewhere else
   * and stealing focus back would fight them.
   */
  const endRename = (commit: boolean, refocus = true): void => {
    // Guard against the exit re-entering through blur. Handing focus back to the table blurs the
    // input, and React fires that blur handler with the `renaming` value from its own render — so
    // an Escape would set renaming to null, steal focus, and then the stale blur would commit the
    // text it had just thrown away. Escape has to mean reverted.
    if (!renaming || endingRef.current) return;
    endingRef.current = true;
    queueMicrotask(() => { endingRef.current = false; });
    const text = renaming.text.trim();
    // An emptied title is an editing state, not a value — the same rule the board title follows.
    if (commit && text) useStore.getState().setTaskText(renaming.id, text);
    setRenaming(null);
    if (refocus) rootRef.current?.focus({ preventScroll: true });
  };
  const [dropOn, setDropOn] = useState<{ id: ID; place: 'before' | 'after' } | null>(null);
  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const sprintName = useMemo(() => new Map(sprints.map((s) => [s.id, s.label])), [sprints]);
  const today = todayISO();
  const states = useBoardStates(tabId);

  const cell = (t: Task, col: ColumnDef): React.ReactNode => {
    if (col.boardField) return <FieldValueCell field={col.boardField} value={t.fields?.[col.boardField.key]} />;
    switch (col.id) {
      case 'status': {
        const state = stateIn(states, t.status);
        return (
          <span className="wt-status" title={state.description ?? undefined}>
            <span className="list-dot" style={stateStyle(state)} />
            <span className="wt-mono">{state.label}</span>
          </span>
        );
      }
      case 'assignee': return <span className="wt-mono">{t.assigneeId ? memberName.get(t.assigneeId) ?? '—' : '—'}</span>;
      case 'due': {
        if (!t.date) return <span className="wt-mono muted">—</span>;
        const active = !isTerminal(states, t.status);
        return <span className={`wt-mono ${active && t.date < today ? 'is-overdue' : ''}`}>{formatDateChip(t.date)}</span>;
      }
      case 'priority': return <span className="wt-mono">{t.priority ? '!'.repeat(t.priority) : '—'}</span>;
      case 'sprint': return <span className="wt-mono">{t.sprintId ? sprintName.get(t.sprintId) ?? '—' : 'Backlog'}</span>;
      case 'parent': {
        const parent = t.parentTaskId ? tasksById[t.parentTaskId] : undefined;
        return <span className={`wt-mono ${parent ? '' : 'muted'}`}>{parent ? parent.text || '(untitled)' : '—'}</span>;
      }
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
      style={{ '--wt-cols': grid.wide, '--wt-cols-narrow': grid.narrow, '--wt-min': `${grid.min}px` } as React.CSSProperties}
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
        <button type="button" className={`wt-th ${sort.key === 'title' ? 'is-sorted' : ''}`} onClick={() => onSort('title')} title={headTitle('Title', sort.key === 'title')}>
          Title{sort.key === 'title' && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
        </button>
        {columns.map((c) => {
          if (!c.sortKey) return <span key={c.id} className={`wt-th ${c.id === 'parent' ? 'wt-parent' : ''}`}>{c.label}</span>;
          const key = c.sortKey;
          const sortButton = (
            <button
              type="button"
              className={`wt-th ${sort.key === key ? 'is-sorted' : ''}`}
              onClick={() => onSort(key)}
              title={headTitle(c.label, sort.key === key, GROUPABLE.has(key))}
            >
              {c.label}{sort.key === key && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
            </button>
          );
          const field = c.boardField;
          if (!field || !isAdmin) return <span key={c.id} className="wt-th-cell">{sortButton}</span>;
          return (
            <span key={c.id} className="wt-th-cell">
              {sortButton}
              <button
                type="button"
                className="wt-th-more"
                aria-label={`${c.label} column options`}
                aria-expanded={pop?.kind === 'field' && pop.field.key === field.key}
                onClick={(e) => setPop({ kind: 'field', field, anchor: e.currentTarget.getBoundingClientRect() })}
              >
                <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </span>
          );
        })}
        <span className="wt-th wt-open-th">
          {isAdmin && (
            <button
              type="button"
              className="wt-add-col"
              aria-label="Add a column"
              title="Add a column"
              aria-expanded={pop?.kind === 'add'}
              onClick={(e) => setPop({ kind: 'add', anchor: e.currentTarget.getBoundingClientRect() })}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          )}
        </span>
      </div>

      {pop?.kind === 'add' && <AddColumn tabId={tabId} fieldCount={fieldCount} anchor={pop.anchor} onClose={closePop} />}
      {pop?.kind === 'field' && (
        <FieldColumnMenu key={pop.field.key} tabId={tabId} field={pop.field} columns={columnIds} anchor={pop.anchor} onClose={closePop} />
      )}

      {groups.map((g) => {
        if (!g.tasks.length) return null; // an empty group is a column in the board layout, not a row here
        return (
          <div key={g.key} className="wt-group">
            {g.tasks.map((t) => {
              const descHit = descriptionMatch(t, query);
              const done = isTerminal(states, t.status);
              const depth = nesting ? nesting.depthOf(t.id) : 0;
              const kids = nesting ? nesting.hasChildren(t.id) : false;
              return (
                <div
                  key={t.id}
                  role="row"
                  aria-selected={selection.has(t.id)}
                  data-row={t.id}
                  className={`wt-row ${selection.has(t.id) ? 'is-selected' : ''} ${done ? 'is-done' : ''} ${contextIds.has(t.id) ? 'is-context' : ''} ${cursor?.row === t.id ? 'is-cursor' : ''}`}
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
                    {editable && !contextIds.has(t.id) && (
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
                        onBlur={() => endRename(true, false)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
                          else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
                          else if (e.altKey && e.key.startsWith('Arrow')) {
                            // Moving the task mid-edit: keep the text, then move it.
                            e.preventDefault();
                            endRename(true);
                            if (e.key === 'ArrowUp') onShift(t.id, -1);
                            else if (e.key === 'ArrowDown') onShift(t.id, 1);
                            else if (e.key === 'ArrowRight') onNest(t.id);
                            else onUnnest(t.id);
                          }
                          else if (
                            (e.key === 'ArrowRight' && atEdge(e.currentTarget, 'end'))
                            || (e.key === 'ArrowLeft' && atEdge(e.currentTarget, 'start'))
                          ) {
                            // Past the end of the text, → carries on to the next field, the way it
                            // would past the end of a cell in a sheet; inside the text it is a caret.
                            e.preventDefault();
                            endRename(true);
                            const dir = e.key === 'ArrowRight' ? 1 : -1;
                            setCursor({ row: t.id, col: stepCol(t.id, COL.title, dir) });
                          }
                          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            // Commit and keep going, the way leaving a line in a document does —
                            // otherwise the only way out of an edit is a key that stops you dead.
                            e.preventDefault();
                            endRename(true);
                            moveRow(e.key === 'ArrowDown' ? 1 : -1);
                          }
                          e.stopPropagation(); // the table's own keys must not fire while typing
                        }}
                      />
                    ) : descHit ? (
                      <span className="wt-title-stack">
                        <button type="button" className="wt-title" title="Click to edit" onClick={() => { putCursor(t.id, COL.title); if (isTouch()) onOpenTask(t.id); }} onDoubleClick={() => startRename(t.id)}>
                          {t.text || <em className="muted">(empty)</em>}
                        </button>
                        <span className="wt-desc-hit" title={t.description}>In description: {descHit}</span>
                      </span>
                    ) : (
                      /* Not a link any more. A click parks the cursor here; a second click, a
                         double-click, Enter, or simply typing starts the rename. Opening the task
                         is the arrow at the end of the row, and only that (§T2). */
                      <button
                        type="button"
                        className="wt-title"
                        title="Click to edit"
                        // A single click only parks the cursor. It used to start the rename when
                        // the cursor was already on this cell — but the row's own mousedown had
                        // just put it there, so the FIRST click dropped you into an input you had
                        // not asked for, with left/right moving a caret instead of cells.
                        // On a touch screen there is no double-click and no hover, so a tap opens
                        // the task; renaming lives on the task page there.
                        onClick={() => { putCursor(t.id, COL.title); if (isTouch()) onOpenTask(t.id); }}
                        onDoubleClick={() => startRename(t.id)}
                      >
                        {t.text || <em className="muted">(empty)</em>}
                      </button>
                    )}
                  </span>

                  {columns.map((c, ci) => {
                    const col = COL.first + ci;
                    const focused = cursor?.row === t.id && cursor.col === col ? 'is-focused' : '';
                    // Parent and custom fields are text, not a menu: the arrow is the only way out
                    // of a row, a parent included, and a field is edited on the task's page.
                    const bf = c.boardField;
                    if (bf) {
                      const value = t.fields?.[bf.key];
                      const editing = fieldEdit?.id === t.id && fieldEdit.key === bf.key;
                      return (
                        <span
                          key={c.id}
                          data-col={col}
                          className={`wt-cell wt-field-cell ${editable ? 'is-editable' : ''} ${editing ? 'is-editing' : ''} ${focused}`}
                          title={editable && !editing ? `Click to edit ${bf.label}` : undefined}
                          onClick={(e) => {
                            // The link itself is followed, not edited.
                            if (editing || (e.target as Element).closest('a')) return;
                            putCursor(t.id, col);
                            if (editable) setFieldEdit({ id: t.id, key: bf.key });
                          }}
                        >
                          {editing
                            ? <FieldCellInput field={bf} value={value} onDone={(text, refocus) => endFieldEdit(t, bf, text, refocus)} />
                            : <FieldValueCell field={bf} value={value} />}
                        </span>
                      );
                    }
                    if (!c.field) {
                      return (
                        <span key={c.id} data-col={col} className={`wt-cell is-static ${c.id === 'parent' ? 'wt-parent' : ''} ${focused}`}>
                          {cell(t, c)}
                        </span>
                      );
                    }
                    return (
                      <button
                        key={c.id}
                        type="button"
                        data-col={col}
                        className={`wt-cell ${focused}`}
                        disabled={!editable}
                        onClick={() => {
                          putCursor(t.id, col);
                          openCellByIndex(t.id, col, selection.has(t.id) ? [...selection] : [t.id]);
                        }}
                      >
                        {cell(t, c)}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    data-col={last}
                    className={`wt-cell wt-open ${cursor?.row === t.id && cursor.col === last ? 'is-focused' : ''}`}
                    aria-label="Open task"
                    title="Open task"
                    onClick={() => { putCursor(t.id, last); onOpenTask(t.id); }}
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
      {editable && addFields && (
        <div
          className={`wt-row is-add ${cursor?.row === 'add' ? 'is-cursor' : ''}`}
          role="row"
          data-add-row
        >
          <span className="wt-cb" />
          <QuickAdd tabId={tabId} shortcut presetFields={addFields} onCreated={onCreated} />
        </div>
      )}
    </div>
  );
}

/** A custom field's value in its column: a link for a link, email or phone, the text otherwise. */
function FieldValueCell({ field, value }: { field: BoardField; value: FieldValue | undefined }) {
  if (value == null) return <span className="wt-mono muted">—</span>;
  const text = String(value);
  const link = fieldLink(field.type, text);
  if (link) {
    return (
      <a
        className="wt-field-link"
        href={link.href}
        target={field.type === 'url' ? '_blank' : undefined}
        rel="noreferrer noopener"
        title={text}
        // Following the link must not also put the cursor on the row or drag it.
        onMouseDown={(e) => e.stopPropagation()}
        draggable={false}
      >
        {link.text}
      </a>
    );
  }
  if (field.type === 'number') return <span className="wt-mono">{typeof value === 'number' ? value.toLocaleString() : text}</span>;
  return <span className="wt-field-text" title={text}>{text}</span>;
}

/** The input a field cell becomes while it is edited. It reports once, however it is left. */
function FieldCellInput({ field, value, onDone }: {
  field: BoardField;
  value: FieldValue | undefined;
  onDone: (text: string | null, refocus: boolean) => void;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const done = useRef(false);
  const finish = (text: string | null, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(text, refocus);
  };
  return (
    <input
      className="wt-field-input"
      autoFocus
      type={FIELD_INPUT_TYPE[field.type]}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      aria-label={field.label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => finish(draft, false)}
      onKeyDown={(e) => {
        e.stopPropagation(); // the table's own keys must not fire while typing
        if (e.key === 'Enter') { e.preventDefault(); finish(draft, true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null, true); }
      }}
    />
  );
}

/** Columns whose header click groups the rows as well as sorting them (BOARD_FILTERS_PLAN D5). */
const GROUPABLE: ReadonlySet<SortKey> = new Set<SortKey>(['status', 'assignee', 'sprint']);

function headTitle(name: string, active: boolean, groups = false): string {
  const what = groups ? `Group by ${name}` : `Sort by ${name}`;
  return active ? `${what} — click to reverse, again to clear` : what;
}

/** Caret collapsed at the start or end of an input — where an arrow key stops being a caret move. */
function atEdge(input: HTMLInputElement, edge: 'start' | 'end'): boolean {
  const { selectionStart: a, selectionEnd: b, value } = input;
  if (a === null || a !== b) return false;
  return edge === 'start' ? a === 0 : a === value.length;
}
