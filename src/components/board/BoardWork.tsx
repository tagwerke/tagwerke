// The board's work view (NOTES_SPLIT_PLAN §N2).
//
// Everything that decides what you are looking at — which tasks (filters), grouped how, sorted how,
// what is selected — lives here. The active column header is both the sort and the grouping
// (BOARD_FILTERS_PLAN D5).
//
// The toolbar is built around the search box. It searches titles and descriptions; the button at
// its right edge opens every other filter (sprint, assignee, priority) in one menu, and only the
// status pills stay in the bar. The button shows how many of the menu's filters are on, so a filter
// you cannot see still says it is there.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { childrenOf, descendantsOf, siblingsOf, taskDepth, useBoardOutline, useStore } from '../../store';
import { showToast } from '../../toast/useToast';
import { TaskActionMenu } from '../common/TaskActionMenu';
import { WorkTable } from './WorkTable';
import { groupingOfSort, groupTasks, sortTasks, type Sort, type SortKey } from './workView';
import { TASK_ACTIONS, type FocusField } from '../../tasks/actions';
import { boardTaskPath, navigate } from '../../util/router';
import { ViewSwitcher } from './ViewSwitcher';
import { newestFirst } from '../../util/sprints';
import { DocumentStrip } from '../documents/DocumentStrip';
import { SecretsView } from '../secrets/SecretsView';
import { MultiSelect } from '../common/MultiSelect';
import { FilterSearch } from '../common/FilterSearch';
import { PRIORITY_LABELS } from '../../util/filter';
import {
  applyFilters, BACKLOG, hasActiveFilters, matchesFilters, NO_FILTERS, presetFromFilters, pruneFilters, UNASSIGNED, type WorkFilters,
} from './workFilters';
import type { BoardSettingsSection, BoardView, ID, Member, Sprint } from '../../types';
import { stateStyle, useBoardStates } from '../../tasks/states';
import { useBoardFields } from '../../tasks/fields';
import { buildColumns, type ColumnDef } from './workColumns';
import { isDone, visible as visibleStates } from '../../../shared/status';
import { EmptyState } from '../common/EmptyState';

/** Shared empties. `?? []` would mint a new array each render and churn every memo below. */
const NO_MEMBERS: Member[] = [];
const NO_SPRINTS: Sprint[] = [];
const NO_COLUMNS: string[] = [];

const SORT_KEY = (tabId: ID) => `tw:work-sort:${tabId}`;
const PRIORITIES = [1, 2, 3] as const;
const SORT_KEYS: readonly SortKey[] = ['rank', 'title', 'status', 'assignee', 'due', 'priority', 'sprint'];
const RANK_SORT: Sort = { key: 'rank', dir: 'asc' };
const NO_PINNED: ReadonlySet<ID> = new Set();

/**
 * The table's sort — which is also its grouping (BOARD_FILTERS_PLAN D5). Remembered per board, as
 * the grouping was; localStorage is a per-viewer convenience, so a browser that refuses it just
 * opens on the outline.
 */
function readSort(tabId: ID): Sort {
  try {
    const raw = localStorage.getItem(SORT_KEY(tabId)) ?? '';
    const cut = raw.lastIndexOf(':'); // a field's key is `f:<key>`, so the direction is after the LAST colon
    const key = raw.slice(0, cut);
    const dir = raw.slice(cut + 1);
    if ((SORT_KEYS.includes(key as SortKey) || key.startsWith('f:')) && key !== 'rank' && (dir === 'asc' || dir === 'desc')) {
      return { key: key as SortKey, dir };
    }
  } catch { /* fall through */ }
  return RANK_SORT;
}

/** A sort is only kept while its column is on the table: there would be no header to undo it. */
const sortShown = (sort: Sort, columns: readonly ColumnDef[]): Sort =>
  sort.key === 'rank' || sort.key === 'title' || columns.some((c) => c.sortKey === sort.key) ? sort : RANK_SORT;

export function BoardWork({ tabId, filters: rawFilters, onFilters, view, onViewChange }: {
  tabId: ID;
  filters: WorkFilters;
  onFilters: (update: (f: WorkFilters) => WorkFilters) => void;
  view: BoardView;
  onViewChange: (v: BoardView) => void;
}) {
  const { list: outline } = useBoardOutline(tabId);
  const tasksById = useStore((s) => s.tasks);
  const members = useStore((s) => s.membersByBoard[tabId]) ?? NO_MEMBERS;
  const sprints = useStore((s) => s.sprintsByBoard[tabId]) ?? NO_SPRINTS;
  const states = useBoardStates(tabId);
  const role = useStore((s) => s.tabs[tabId]?.role);
  const editable = role === 'editor' || role === 'admin';
  const openBoardSettings = useStore((s) => s.openBoardSettings);
  // Each filter's list ends in a link to where that list is kept, in board settings — the way to
  // find "where do I change the states" is the place you noticed you wanted to.
  const isAdmin = role === 'admin';
  const settingsLink = (label: string, section: BoardSettingsSection) => ({
    label,
    onSelect: () => openBoardSettings(tabId, section),
  });

  const fields = useBoardFields(tabId);
  const columnIds = useStore((s) => s.tabs[tabId]?.tableColumns) ?? NO_COLUMNS;
  const columns = useMemo(() => buildColumns(columnIds, fields), [columnIds, fields]);

  const [chosenSort, setSort] = useState<Sort>(() => readSort(tabId));
  const sort = sortShown(chosenSort, columns);
  const grouping = groupingOfSort(sort);
  // §I.3: a column sort makes "between these two rows" a lie, so the handle is not offered.
  const canReorder = sort.key === 'rank';
  const [selection, setSelection] = useState<Set<ID>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<ID>>(new Set());
  const menuSeq = useRef(0);
  const [menu, setMenu] = useState<{
    ids: ID[]; x: number; y: number; field?: FocusField; onStep?: (dir: -1 | 1) => void; seq: number;
  } | null>(null);

  useEffect(() => {
    try {
      if (chosenSort.key === 'rank') localStorage.removeItem(SORT_KEY(tabId));
      else localStorage.setItem(SORT_KEY(tabId), `${chosenSort.key}:${chosenSort.dir}`);
    } catch { /* storage disabled — the choice just doesn't persist */ }
  }, [tabId, chosenSort]);

  /**
   * Nesting is shown only when the rows are a contiguous outline: no grouping, and the board's own
   * rank order. Group by status and a parent and its child routinely land in different sections, so
   * an indent would point at nothing that is on screen — the crumb in the Parent column carries the
   * relationship instead, and holds wherever a task falls.
   */
  const isOutline = grouping === 'none' && sort.key === 'rank';

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
    return groupTasks(visible, grouping, members, sprints, states, sort.dir).map((g) => ({
      ...g,
      tasks: sortTasks(g.tasks, sort, memberName, sprintStart, states),
    }));
  }, [visible, grouping, members, sprints, states, sort]);

  // Selection is scoped to what is on screen: a filter or grouping change must not leave a hidden
  // task selected and then act on it from the bulk bar.
  const visibleIds = useMemo(
    () => new Set(visible.filter((t) => !contextIds.has(t.id)).map((t) => t.id)),
    [visible, contextIds],
  );
  const selected = useMemo(() => [...selection].filter((id) => visibleIds.has(id)), [selection, visibleIds]);

  const onSort = useCallback((key: SortKey) => {
    setSort(() => {
      // From the sort on screen, not the remembered one: a remembered sort on a column that has
      // since been hidden is not what the header shows.
      if (sort.key !== key) return { key, dir: 'asc' };
      if (sort.dir === 'asc') return { key, dir: 'desc' };
      return RANK_SORT; // third click returns to the board's own order
    });
  }, [sort]);

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

  /** What a task added under the current filters starts as; null hides the add line (D10). */
  const filterPreset = useMemo(() => presetFromFilters(filters), [filters]);

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

  const setQuery = useCallback(
    (query: string) => onFilters((f) => (f.query === query ? f : { ...f, query })),
    [onFilters],
  );
  const clearFilters = useCallback(() => onFilters(() => NO_FILTERS), [onFilters]);

  // How many of the search box's menu filters are on shows on its button, open or not.
  const menuCount = [filters.sprints, filters.assignees, filters.priorities].filter((l) => l.length > 0).length;
  const clearMenuFilters = () => onFilters((f) => ({ ...f, sprints: [], assignees: [], priorities: [] }));

  const sprintOptions = useMemo(() => [
    { value: BACKLOG, label: 'Backlog' },
    ...newestFirst(sprints).map((s) => ({ value: s.id, label: s.isCurrent ? `${s.label} · now` : s.label })),
  ], [sprints]);
  // Each pill counts what the OTHER filters leave, so it says what pressing it would show.
  const statusCounts = useMemo(() => {
    const others = { ...filters, statuses: [] };
    const counts = new Map<string, number>();
    for (const t of outline) if (matchesFilters(t, others)) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    return counts;
  }, [outline, filters]);
  const toggleStatus = (key: string) => onFilters((f) => ({
    ...f,
    statuses: f.statuses.includes(key) ? f.statuses.filter((x) => x !== key) : [...f.statuses, key],
  }));
  const togglePriority = (p: string) => onFilters((f) => ({
    ...f,
    priorities: f.priorities.includes(p) ? f.priorities.filter((x) => x !== p) : [...f.priorities, p],
  }));
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
          <div className="scope-right"><ViewSwitcher view={view} onChange={onViewChange} /></div>
        </div>
        <DocumentStrip variant="board" boardId={tabId} />
      </div>
    );
  }
  // Secrets: same whole-surface treatment as Files. Admin-only — TabView never routes anyone else
  // here, and the server refuses them regardless.
  if (view === 'secrets') {
    return (
      <div className="board-work">
        <div className="work-toolbar">
          <div className="scope-right"><ViewSwitcher view={view} onChange={onViewChange} /></div>
        </div>
        <div className="secrets-surface"><SecretsView key={tabId} boardId={tabId} /></div>
      </div>
    );
  }

  const shown = visible.filter((t) => !contextIds.has(t.id));
  const total = shown.length;
  const doneCount = shown.filter((t) => isDone(states, t.status)).length;
  const noMatch = total === 0 && filtersActive;

  return (
    <div className="board-work">
      {/* Search first, with every filter but status behind the button at its right edge; then the
          status pills; then Clear and the view switcher at the end. */}
      <div className="work-toolbar">
        <FilterSearch
          query={filters.query}
          onQuery={setQuery}
          label="Search titles and descriptions"
          menuTitle="Sprint, assignee and priority filters"
          menuCount={menuCount}
          onClearMenu={clearMenuFilters}
        >
          {/* The sprint filter is always offered once a board has sprints: a filter you cannot
              reach is a bug, and a board whose work is all in the backlog reads as an empty board. */}
          {sprints.length > 0 && (
            <div className="work-filter-row">
              <span>Sprint</span>
              <MultiSelect
                label="Filter by sprint"
                noun="sprints"
                options={sprintOptions}
                selected={filters.sprints}
                onChange={(sprintsSel) => onFilters((f) => ({ ...f, sprints: sprintsSel }))}
                footer={settingsLink('Manage sprints…', 'sprints')}
              />
            </div>
          )}
          {members.length > 0 && (
            <div className="work-filter-row">
              <span>Assignee</span>
              <MultiSelect
                label="Filter by assignee"
                noun="people"
                options={assigneeOptions}
                selected={filters.assignees}
                onChange={(assignees) => onFilters((f) => ({ ...f, assignees }))}
                footer={settingsLink(isAdmin ? 'Invite someone…' : 'See who’s on this board…', 'people')}
              />
            </div>
          )}
          <div className="work-filter-row">
            <span>Priority</span>
            <div className="work-filter-pills">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pill pill-priority p${p}`}
                  aria-pressed={filters.priorities.includes(String(p))}
                  onClick={() => togglePriority(String(p))}
                  title={`${PRIORITY_LABELS[p]} priority`}
                >
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          <div className="work-filter-foot">
            <button type="button" className="btn tiny ghost" onClick={() => openBoardSettings(tabId, 'table')}>
              Table columns…
            </button>
          </div>
        </FilterSearch>

        <div className="work-status-pills" role="group" aria-label="Filter by status">
          {visibleStates(states).map((st) => (
            <button
              key={st.key}
              type="button"
              className="pill md work-status-pill"
              style={stateStyle(st)}
              aria-pressed={filters.statuses.includes(st.key)}
              title={st.description ?? `Show only ${st.label}`}
              onClick={() => toggleStatus(st.key)}
            >
              <span className="list-dot" aria-hidden />
              {st.label}
              <span className="work-status-count">{statusCounts.get(st.key) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="scope-right">
          {filtersActive && <button type="button" className="scope-clear" onClick={clearFilters}>Clear</button>}
          <ViewSwitcher view={view} onChange={onViewChange} />
        </div>
      </div>

      {noMatch && (
        <div className="work-empty muted">
          No tasks match these filters.{' '}
          <button type="button" className="btn tiny ghost" onClick={clearFilters}>Clear filters</button>
        </div>
      )}

      {total === 0 && !noMatch && !editable ? (
        <EmptyState size="block">No tasks on this board yet.</EmptyState>
      ) : (
        <WorkTable
          tabId={tabId}
          groups={groups}
          sort={sort}
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
          columns={columns}
          columnIds={columnIds}
          fieldCount={fields.length}
          isAdmin={isAdmin}
          query={filters.query}
        />
      )}

      {selected.length > 0 && (
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
        <div className="count work-count">{total} task{total === 1 ? '' : 's'} · {doneCount} done</div>
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
