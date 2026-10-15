// The board's work view (NOTES_SPLIT_PLAN §N2).
//
// Table and Kanban are two LAYOUTS of this one component, not two views. Everything that decides
// what you are looking at — which tasks (filters), grouped how, sorted how, what is selected — lives
// here, so switching layout keeps it. In the table the active column header is both the sort and the
// grouping (BOARD_FILTERS_PLAN D5); the Kanban's columns are always Status.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { childrenOf, descendantsOf, siblingsOf, taskDepth, useBoardOutline, useStore } from '../../store';
import { showToast } from '../../toast/useToast';
import { TaskActionMenu } from '../common/TaskActionMenu';
import { WorkTable } from './WorkTable';
import { WorkBoard } from './WorkBoard';
import { groupingOfSort, groupTasks, sortTasks, statusOfGroup, type Grouping, type Sort, type SortKey, type WorkLayout } from './workView';
import { actionForField, TASK_ACTIONS, type FocusField } from '../../tasks/actions';
import { boardTaskPath, navigate } from '../../util/router';
import type { DraftFields } from '../../tasks/createTask';
import { ViewSwitcher } from './ViewSwitcher';
import { newestFirst } from '../../util/sprints';
import { DocumentStrip } from '../documents/DocumentStrip';
import { STATUS_LABEL, STATUS_ORDER } from '../StatusControl';
import { MultiSelect } from '../common/MultiSelect';
import {
  applyFilters, BACKLOG, hasActiveFilters, NO_FILTERS, NO_PRIORITY, presetFromFilters, pruneFilters, UNASSIGNED, type WorkFilters,
} from './workFilters';
import type { BoardView, ID, Member, Sprint } from '../../types';

/** Shared empties. `?? []` would mint a new array each render and churn every memo below. */
const NO_MEMBERS: Member[] = [];
const NO_SPRINTS: Sprint[] = [];

const SORT_KEY = (tabId: ID) => `tw:work-sort:${tabId}`;
const SORT_KEYS: readonly SortKey[] = ['rank', 'title', 'status', 'assignee', 'due', 'priority', 'sprint'];
const RANK_SORT: Sort = { key: 'rank', dir: 'asc' };
const NO_PINNED: ReadonlySet<ID> = new Set();
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The table's sort — which is also its grouping (BOARD_FILTERS_PLAN D5). Remembered per board, as
 * the grouping was; localStorage is a per-viewer convenience, so a browser that refuses it just
 * opens on the outline.
 */
function readSort(tabId: ID): Sort {
  try {
    const [key, dir] = (localStorage.getItem(SORT_KEY(tabId)) ?? '').split(':');
    if (SORT_KEYS.includes(key as SortKey) && key !== 'rank' && (dir === 'asc' || dir === 'desc')) {
      return { key: key as SortKey, dir };
    }
  } catch { /* fall through */ }
  return RANK_SORT;
}

export function BoardWork({ tabId, layout, filters: rawFilters, onFilters, view, onViewChange }: {
  tabId: ID;
  layout: WorkLayout;
  filters: WorkFilters;
  onFilters: (update: (f: WorkFilters) => WorkFilters) => void;
  view: BoardView;
  onViewChange: (v: BoardView) => void;
}) {
  const { list: outline } = useBoardOutline(tabId);
  const tasksById = useStore((s) => s.tasks);
  const members = useStore((s) => s.membersByBoard[tabId]) ?? NO_MEMBERS;
  const sprints = useStore((s) => s.sprintsByBoard[tabId]) ?? NO_SPRINTS;
  const role = useStore((s) => s.tabs[tabId]?.role);
  const editable = role === 'editor' || role === 'admin';

  const [sort, setSort] = useState<Sort>(() => readSort(tabId));
  // The Kanban's columns ARE its grouping, so it is always Status in rank order and ignores the
  // table's header choice. The two are independent: switching layout never wipes the outline.
  const isTable = layout === 'table';
  const effSort: Sort = isTable ? sort : RANK_SORT;
  const grouping: Grouping = isTable ? groupingOfSort(sort) : 'status';
  // §I.3: a column sort makes "between these two rows" a lie, so the handle is not offered.
  const canReorder = effSort.key === 'rank';
  const [selection, setSelection] = useState<Set<ID>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<ID>>(new Set());
  const menuSeq = useRef(0);
  const [menu, setMenu] = useState<{
    ids: ID[]; x: number; y: number; field?: FocusField; onStep?: (dir: -1 | 1) => void; seq: number;
  } | null>(null);

  useEffect(() => {
    try {
      if (sort.key === 'rank') localStorage.removeItem(SORT_KEY(tabId));
      else localStorage.setItem(SORT_KEY(tabId), `${sort.key}:${sort.dir}`);
    } catch { /* storage disabled — the choice just doesn't persist */ }
  }, [tabId, sort]);

  /**
   * Nesting is shown only when the rows are a contiguous outline: no grouping, and the board's own
   * rank order. Group by status and a parent and its child routinely land in different sections, so
   * an indent would point at nothing that is on screen — the crumb in the Parent column carries the
   * relationship instead, and holds wherever a task falls.
   */
  const isOutline = grouping === 'none' && effSort.key === 'rank';

  // A filter on something that no longer exists (a deleted sprint, a removed member) would show an
  // empty board with nothing to untick, so ids that name nothing are ignored at use. Not written
  // back: until the board's sprints and members have loaded they look absent too.
  const filters = useMemo(
    () => pruneFilters(rawFilters, new Set(sprints.map((s) => s.id)), new Set(members.map((m) => m.id))),
    [rawFilters, sprints, members],
  );
  const filtersActive = hasActiveFilters(filters);

  // Tasks added under a filter stay visible until the filters next change, even if they would not
  // match (a search term the new title lacks): a row that vanishes on creation reads as a lost write.
  // The set remembers which filters it was made under, so a changed filter reads as an empty set
  // without an effect to reset it.
  const [pinState, setPinState] = useState<{ under: WorkFilters; ids: ReadonlySet<ID> }>({ under: rawFilters, ids: NO_PINNED });
  const pinned = pinState.under === rawFilters ? pinState.ids : NO_PINNED;
  const onCreated = useCallback(
    (id: ID) => setPinState((p) => ({ under: rawFilters, ids: new Set(p.under === rawFilters ? p.ids : []).add(id) })),
    [rawFilters],
  );

  const filtered = useMemo(
    () => applyFilters(outline, filters, tasksById, isOutline, pinned),
    [outline, filters, tasksById, isOutline, pinned],
  );
  const contextIds = filtered.context;

  const hiddenByCollapse = useMemo(() => {
    if (!isOutline || !collapsed.size) return null;
    const hidden = new Set<ID>();
    for (const id of collapsed) for (const d of descendantsOf(tasksById, id)) hidden.add(d.id);
    return hidden;
  }, [isOutline, collapsed, tasksById]);

  const visible = useMemo(
    () => (hiddenByCollapse ? filtered.tasks.filter((t) => !hiddenByCollapse.has(t.id)) : filtered.tasks),
    [filtered, hiddenByCollapse],
  );

  const groups = useMemo(() => {
    const memberName = new Map(members.map((m) => [m.id, m.name]));
    const sprintStart = new Map(sprints.map((s) => [s.id, s.startsAt]));
    return groupTasks(visible, grouping, members, sprints, effSort.dir).map((g) => ({
      ...g,
      tasks: sortTasks(g.tasks, effSort, memberName, sprintStart),
    }));
  }, [visible, grouping, members, sprints, effSort]);

  // Selection is scoped to what is on screen: a filter or grouping change must not leave a hidden
  // task selected and then act on it from the bulk bar.
  const visibleIds = useMemo(
    () => new Set(visible.filter((t) => !contextIds.has(t.id)).map((t) => t.id)),
    [visible, contextIds],
  );
  const selected = useMemo(() => [...selection].filter((id) => visibleIds.has(id)), [selection, visibleIds]);

  const onSort = useCallback((key: SortKey) => {
    setSort((s) => {
      if (s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return { key: 'rank', dir: 'asc' }; // third click returns to the board's own order
    });
  }, []);

  const onSelect = useCallback((id: ID, mode: 'toggle' | 'range' | 'only') => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (mode === 'only') return new Set([id]);
      if (mode === 'range') {
        // Extend from the last selected row through this one, in the order shown.
        const flat = groups.flatMap((g) => g.tasks.map((t) => t.id));
        const anchor = flat.find((x) => next.has(x));
        if (anchor) {
          const [a, b] = [flat.indexOf(anchor), flat.indexOf(id)].sort((x, y) => x - y);
          for (const x of flat.slice(a, b + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [groups]);

  const openMenu = useCallback((ids: ID[], x: number, y: number, field?: FocusField, onStep?: (dir: -1 | 1) => void) => {
    // `seq` keys the menu: stepping from one cell's menu to the next closes and opens in the same
    // tick, and without a new key React would keep the first menu's state for the second field.
    // A counter of its own, not `prev.seq + 1` — the close has already nulled `prev` by then.
    menuSeq.current += 1;
    setMenu({ ids, x, y, field, onStep, seq: menuSeq.current });
  }, []);

  /** The keyboard runs the SAME actions the menu does, so the two can never disagree (§N3). */
  const runAction = useCallback((id: string, taskId: ID) => {
    const ctx = { ids: [taskId], tabId };
    const action = TASK_ACTIONS.find((a) => a.id === id);
    if (action?.enabled(ctx)) action.run?.(ctx);
  }, [tabId]);

  /** Drop onto a column: set whichever field the board is grouped by. Never a reorder (§I.4). */
  const onDropOn = useCallback((taskId: ID, groupKey: string) => {
    const store = useStore.getState();
    const ctx = { ids: [taskId], tabId };
    if (grouping === 'status') {
      const status = statusOfGroup(groupKey);
      if (!status) return;
      // Through the action so the review gate and the single cascade offer both apply.
      actionForField('status')?.options?.(ctx).find((o) => o.key === status)?.run();
      return;
    }
    if (grouping === 'assignee') {
      store.setTaskAssignee(taskId, groupKey === '~none' ? undefined : groupKey);
      return;
    }
    if (grouping === 'sprint') {
      store.setTaskMeta(taskId, { sprintId: groupKey === '~none' ? undefined : groupKey });
    }
  }, [grouping, tabId]);

  /** What a task added under the current filters starts as; null hides the add line (D10). */
  const filterPreset = useMemo(() => presetFromFilters(filters), [filters]);
  // A Kanban column already fixes the status, so a status filter must not hide its add line.
  const columnPreset = useMemo(() => presetFromFilters(filters, true), [filters]);

  /** What a task added in a given Kanban column starts as: the column's status plus the filters'. */
  const addFieldsFor = useCallback((groupKey: string): DraftFields | null => {
    const status = statusOfGroup(groupKey);
    if (!columnPreset || !status) return null;
    return { ...columnPreset, status };
  }, [columnPreset]);

  /**
   * Put `id` directly before or after `targetId`, a sibling. The neighbours come from the SIBLING
   * list, not from the rows on screen: on screen the row above a task can be another task's
   * sub-task, and a rank between keys from two different sibling sets is either out of order
   * (so the move fell back to appending — the task jumped to the end) or lands arbitrarily.
   */
  const placeBeside = useCallback((id: ID, targetId: ID, place: 'before' | 'after') => {
    const store = useStore.getState();
    const t = store.tasks[id];
    if (!t) return;
    const seq = siblingsOf(store.tasks, t.homeTabId, t.parentTaskId).filter((s) => s.id !== id);
    const i = seq.findIndex((s) => s.id === targetId);
    if (i < 0) return;
    const before = place === 'before' ? seq[i - 1] : seq[i];
    const after = place === 'before' ? seq[i] : seq[i + 1];
    store.moveTask(id, { before: before?.id, after: after?.id });
  }, []);

  const onReorder = placeBeside;

  /**
   * Alt+↑/↓: swap with the neighbouring sibling — among the ones in this task's group, so under a
   * grouping it moves past something you can see rather than a sibling filed elsewhere. Only in the
   * board's own order, for the reason the drag handle is: under a column sort "above" is not a
   * position the task can hold.
   */
  const onShift = useCallback((id: ID, dir: -1 | 1) => {
    if (!canReorder) return showToast('Reordering needs the board’s own order — clear the column sort');
    const store = useStore.getState();
    const t = store.tasks[id];
    const group = groups.find((g) => g.tasks.some((x) => x.id === id));
    if (!t || !group) return;
    const shown = new Set(group.tasks.map((x) => x.id));
    const sibs = siblingsOf(store.tasks, t.homeTabId, t.parentTaskId).filter((s) => shown.has(s.id));
    const target = sibs[sibs.findIndex((s) => s.id === id) + dir];
    if (!target) return;
    placeBeside(id, target.id, dir < 0 ? 'before' : 'after');
  }, [canReorder, groups, placeBeside]);

  // The search box keeps its own text and reports it after a pause, so typing does not re-filter
  // the board on every keystroke. Esc clears it at once.
  const [text, setText] = useState(rawFilters.query);
  useEffect(() => {
    const h = setTimeout(() => onFilters((f) => (f.query === text ? f : { ...f, query: text })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [text, onFilters]);

  const clearFilters = useCallback(() => {
    setText('');
    onFilters(() => NO_FILTERS);
  }, [onFilters]);

  const sprintOptions = useMemo(() => [
    { value: BACKLOG, label: 'Backlog' },
    ...newestFirst(sprints).map((s) => ({ value: s.id, label: s.isCurrent ? `${s.label} · now` : s.label })),
  ], [sprints]);
  const statusOptions = useMemo(
    () => STATUS_ORDER.map((st) => ({ value: st, label: STATUS_LABEL[st] })),
    [],
  );
  const priorityOptions = useMemo(() => [
    { value: '1', label: '!' },
    { value: '2', label: '!!' },
    { value: '3', label: '!!!' },
    { value: NO_PRIORITY, label: 'No priority' },
  ], []);
  const assigneeOptions = useMemo(() => [
    ...members.map((m) => ({ value: m.id, label: m.name })),
    { value: UNASSIGNED, label: 'Unassigned' },
  ], [members]);

  // Files is a view of the board, not a layout of its tasks — so it takes the whole surface and
  // keeps only the switcher, the way the Notes view does. It is answered HERE rather than beside
  // Notes in TabView because 'files' already routes through this component (anything that isn't
  // Notes does), and splitting the answer across two files is how a fourth view ends up rendering
  // a table on one path and a strip on the other. The early return sits below every hook, so the
  // hook order is identical on both paths.
  if (view === 'files') {
    return (
      <div className="board-work">
        <div className="work-toolbar">
          <span className="work-spacer" />
          <ViewSwitcher view={view} onChange={onViewChange} />
        </div>
        <DocumentStrip variant="board" boardId={tabId} />
      </div>
    );
  }

  const shown = visible.filter((t) => !contextIds.has(t.id));
  const total = shown.length;
  const doneCount = shown.filter((t) => t.status === 'done').length;
  const noMatch = total === 0 && filtersActive;

  return (
    <div className="board-work">
      <div className="work-toolbar">
        {/* The sprint filter is always shown once a board has sprints: a filter you cannot see is a
            bug, and a board whose work is all in the backlog reads as an empty board. */}
        {sprints.length > 0 && (
          <span className="work-control">
            <span className="work-control-label">Sprint</span>
            <MultiSelect
              label="Filter by sprint"
              noun="sprints"
              options={sprintOptions}
              selected={filters.sprints}
              onChange={(sprintsSel) => onFilters((f) => ({ ...f, sprints: sprintsSel }))}
            />
          </span>
        )}
        <span className="work-control">
          <span className="work-control-label">Status</span>
          <MultiSelect
            label="Filter by status"
            noun="statuses"
            options={statusOptions}
            selected={filters.statuses}
            onChange={(statuses) => onFilters((f) => ({ ...f, statuses }))}
          />
        </span>
        <span className="work-control">
          <span className="work-control-label">Priority</span>
          <MultiSelect
            label="Filter by priority"
            noun="priorities"
            options={priorityOptions}
            selected={filters.priorities}
            onChange={(priorities) => onFilters((f) => ({ ...f, priorities }))}
          />
        </span>
        {members.length > 0 && (
          <span className="work-control">
            <span className="work-control-label">Assignee</span>
            <MultiSelect
              label="Filter by assignee"
              noun="people"
              options={assigneeOptions}
              selected={filters.assignees}
              onChange={(assignees) => onFilters((f) => ({ ...f, assignees }))}
            />
          </span>
        )}
        {filtersActive && (
          <button type="button" className="list-mode" onClick={clearFilters}>Clear filters</button>
        )}
        <span className="work-spacer" />
        <input
          type="search"
          className="work-search"
          value={text}
          placeholder="Search tasks"
          aria-label="Search tasks"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (text) {
              setText('');
              onFilters((f) => (f.query ? { ...f, query: '' } : f));
            } else {
              e.currentTarget.blur();
            }
          }}
        />
        <ViewSwitcher view={view} onChange={onViewChange} />
      </div>

      {noMatch && (
        <div className="work-empty muted">
          No tasks match these filters.{' '}
          <button type="button" className="btn tiny ghost" onClick={clearFilters}>Clear filters</button>
        </div>
      )}

      {total === 0 && !noMatch && (layout === 'board' || !editable) ? (
        <div className="view-placeholder muted">
          {editable ? 'No tasks yet — add one in a column.' : 'No tasks on this board yet.'}
        </div>
      ) : layout === 'table' ? (
        <WorkTable
          tabId={tabId}
          groups={groups}
          sort={effSort}
          onSort={onSort}
          selection={new Set(selected)}
          onSelect={onSelect}
          onOpenMenu={openMenu}
          onOpenTask={(id) => navigate(boardTaskPath(tabId, id))}
          onNest={(id) => runAction('nest', id)}
          onUnnest={(id) => runAction('unnest', id)}
          onDelete={(id) => runAction('delete', id)}
          onSelectAll={(select) => setSelection(select ? new Set(visibleIds) : new Set())}
          nesting={isOutline ? {
            depthOf: (id) => taskDepth(tasksById, id),
            hasChildren: (id) => childrenOf(tasksById, id).length > 0,
            isCollapsed: (id) => collapsed.has(id),
            toggle: (id) => setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            }),
          } : null}
          canReorder={canReorder}
          onReorder={onReorder}
          onShift={onShift}
          members={members}
          sprints={sprints}
          tasksById={tasksById}
          editable={editable}
          contextIds={contextIds}
          addFields={filterPreset}
          onCreated={onCreated}
        />
      ) : (
        <WorkBoard
          tabId={tabId}
          groups={groups}
          onDropOn={onDropOn}
          onOpenTask={(id) => navigate(boardTaskPath(tabId, id))}
          onOpenMenu={openMenu}
          addFieldsFor={addFieldsFor}
          onCreated={onCreated}
          editable={editable}
        />
      )}

      {selected.length > 0 && layout === 'table' && (
        <div className="work-bulk" role="status">
          <span className="work-bulk-n">{selected.length} selected</span>
          <button
            type="button"
            className="btn tiny"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              openMenu(selected, box.left, box.top - 8);
            }}
          >
            Actions
          </button>
          <button type="button" className="btn tiny ghost" onClick={() => setSelection(new Set())}>Clear</button>
        </div>
      )}

      {total > 0 && (
        <div className="work-count">{total} task{total === 1 ? '' : 's'} · {doneCount} done</div>
      )}

      {menu && (
        <TaskActionMenu
          key={menu.seq}
          ids={menu.ids}
          tabId={tabId}
          focusField={menu.field}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStep={menu.onStep}
        />
      )}
    </div>
  );
}
