// The board's work view (NOTES_SPLIT_PLAN §N2).
//
// Table and Kanban are two LAYOUTS of this one component, not two views. Everything that decides
// what you are looking at — which tasks, grouped how, sorted how, what is selected — lives here, so
// switching layout keeps it. That is the whole reason for the shape: "group by assignee" gives you
// a per-person table and a per-person board, and it is one implementation.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { childrenOf, descendantsOf, taskDepth, useBoardOutline, useStore } from '../../store';
import { TaskActionMenu } from '../common/TaskActionMenu';
import { WorkTable } from './WorkTable';
import { WorkBoard } from './WorkBoard';
import { GROUPINGS, groupTasks, sortTasks, statusOfGroup, type Grouping, type Sort, type SortKey, type WorkLayout } from './workView';
import { actionForField, TASK_ACTIONS, type FocusField } from '../../tasks/actions';
import { boardTaskPath, navigate } from '../../util/router';
import type { DraftFields } from '../../tasks/createTask';
import type { SprintFilter } from '../TabView';
import { ViewSwitcher } from './ViewSwitcher';
import { Dropdown } from '../Dropdown';
import type { BoardView, ID, Member, Sprint } from '../../types';

/** Shared empties. `?? []` would mint a new array each render and churn every memo below. */
const NO_MEMBERS: Member[] = [];
const NO_SPRINTS: Sprint[] = [];

const GROUP_KEY = (tabId: ID) => `tw:work-group:${tabId}`;
const SCOPE_KEY = (tabId: ID) => `tw:work-scope:${tabId}`;

/** localStorage is a per-viewer convenience here; a browser that refuses it just doesn't remember. */
function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function BoardWork({ tabId, layout, sprintFilter = 'all', onSprintFilter, view, onViewChange }: {
  tabId: ID;
  layout: WorkLayout;
  sprintFilter?: SprintFilter;
  onSprintFilter: (f: SprintFilter) => void;
  view: BoardView;
  onViewChange: (v: BoardView) => void;
}) {
  const { list: outline } = useBoardOutline(tabId);
  const tasksById = useStore((s) => s.tasks);
  const members = useStore((s) => s.membersByBoard[tabId]) ?? NO_MEMBERS;
  const sprints = useStore((s) => s.sprintsByBoard[tabId]) ?? NO_SPRINTS;
  const role = useStore((s) => s.tabs[tabId]?.role);
  const editable = role === 'editor' || role === 'admin';

  const [grouping, setGrouping] = useState<Grouping>(() =>
    readStored(GROUP_KEY(tabId), ['status', 'assignee', 'sprint', 'none'] as const, 'status'));
  // The busy-board escape hatch from the Kanban (SUBTASKS_PLAN D10): a parent with eight sub-tasks
  // puts nine rows on screen. Kept, because the problem it solves did not go away.
  const [scope, setScope] = useState<'all' | 'roots'>(() =>
    readStored(SCOPE_KEY(tabId), ['all', 'roots'] as const, 'all'));
  const [sort, setSort] = useState<Sort>({ key: 'rank', dir: 'asc' });
  const [selection, setSelection] = useState<Set<ID>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<ID>>(new Set());
  const [menu, setMenu] = useState<{ ids: ID[]; x: number; y: number; field?: FocusField } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_KEY(tabId), grouping);
      localStorage.setItem(SCOPE_KEY(tabId), scope);
    } catch { /* storage disabled — the choice just doesn't persist */ }
  }, [tabId, grouping, scope]);

  // A board layout needs columns to lay out, so "group by nothing" is a table-only choice.
  const effectiveGrouping: Grouping = layout === 'board' && grouping === 'none' ? 'status' : grouping;

  /**
   * Nesting is shown only when the rows are a contiguous outline: no grouping, and the board's own
   * rank order. Group by status and a parent and its child routinely land in different sections, so
   * an indent would point at nothing that is on screen — the crumb in the Parent column carries the
   * relationship instead, and holds wherever a task falls.
   */
  const isOutline = effectiveGrouping === 'none' && sort.key === 'rank' && scope === 'all';

  const hiddenByCollapse = useMemo(() => {
    if (!isOutline || !collapsed.size) return null;
    const hidden = new Set<ID>();
    for (const id of collapsed) for (const d of descendantsOf(tasksById, id)) hidden.add(d.id);
    return hidden;
  }, [isOutline, collapsed, tasksById]);

  const visible = useMemo(() => {
    const bySprint = sprintFilter === 'all' ? outline : outline.filter((t) => (t.sprintId ?? null) === sprintFilter);
    const byScope = scope === 'roots' ? bySprint.filter((t) => !t.parentTaskId) : bySprint;
    return hiddenByCollapse ? byScope.filter((t) => !hiddenByCollapse.has(t.id)) : byScope;
  }, [outline, sprintFilter, scope, hiddenByCollapse]);

  const groups = useMemo(() => {
    const memberName = new Map(members.map((m) => [m.id, m.name]));
    const sprintName = new Map(sprints.map((s) => [s.id, s.label]));
    return groupTasks(visible, effectiveGrouping, members, sprints).map((g) => ({
      ...g,
      tasks: sortTasks(g.tasks, sort, memberName, sprintName),
    }));
  }, [visible, effectiveGrouping, members, sprints, sort]);

  // Selection is scoped to what is on screen: a filter or grouping change must not leave a hidden
  // task selected and then act on it from the bulk bar.
  const visibleIds = useMemo(() => new Set(visible.map((t) => t.id)), [visible]);
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

  const openMenu = useCallback((ids: ID[], x: number, y: number, field?: FocusField) => {
    setMenu({ ids, x, y, field });
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
    if (effectiveGrouping === 'status') {
      const status = statusOfGroup(groupKey);
      if (!status) return;
      // Through the action so the review gate and the single cascade offer both apply.
      actionForField('status')?.options?.(ctx).find((o) => o.key === status)?.run();
      return;
    }
    if (effectiveGrouping === 'assignee') {
      store.setTaskAssignee(taskId, groupKey === '~none' ? undefined : groupKey);
      return;
    }
    if (effectiveGrouping === 'sprint') {
      store.setTaskMeta(taskId, { sprintId: groupKey === '~none' ? undefined : groupKey });
    }
  }, [effectiveGrouping, tabId]);

  /** What a task added in a given column starts as. Null where the column is not expressible. */
  const addFieldsFor = useCallback((groupKey: string): DraftFields | null => {
    if (effectiveGrouping === 'status') {
      const status = statusOfGroup(groupKey);
      return status ? { status } : null;
    }
    if (effectiveGrouping === 'assignee') return groupKey === '~none' ? {} : { assigneeId: groupKey };
    return groupKey === '~none' ? {} : null; // a brand-new task cannot be born into a sprint here
  }, [effectiveGrouping]);

  const onReorder = useCallback((dragId: ID, targetId: ID, place: 'before' | 'after') => {
    const store = useStore.getState();
    const flat = groups.flatMap((g) => g.tasks);
    const at = flat.findIndex((t) => t.id === targetId);
    if (at < 0) return;
    // The pair the dragged task lands between, in the order shown, excluding itself.
    const seq = flat.filter((t) => t.id !== dragId);
    const i = seq.findIndex((t) => t.id === targetId);
    const before = place === 'before' ? seq[i - 1] : seq[i];
    const after = place === 'before' ? seq[i] : seq[i + 1];
    store.moveTask(dragId, { before: before?.id, after: after?.id });
  }, [groups]);

  const total = visible.length;
  const doneCount = visible.filter((t) => t.status === 'done').length;
  const hiddenSubtasks = scope === 'roots' ? outline.length - visible.length : 0;
  // §I.3: a column sort makes "between these two rows" a lie, so the handle is not offered.
  const canReorder = sort.key === 'rank';

  return (
    <div className="board-work">
      <div className="work-toolbar">
        <span className="work-control">
          <span className="work-control-label">Group</span>
          <Dropdown
            className="is-compact"
            value={grouping}
            options={GROUPINGS.filter((g) => layout === 'table' || g.key !== 'none').map((g) => ({ value: g.key, label: g.label }))}
            onChange={(v) => setGrouping(v as Grouping)}
          />
        </span>
        {/* The sprint filter has always been applied on open — a board lands on its current sprint
            — but nothing said so once the Sprints view moved into the panel, so a board whose work
            is all in the backlog read as an empty board. A filter you cannot see is a bug. */}
        {sprints.length > 0 && (
          <span className="work-control">
            <span className="work-control-label">Sprint</span>
            <Dropdown
              className="is-compact"
              value={sprintFilter === 'all' ? 'all' : sprintFilter ?? 'backlog'}
              options={[
                { value: 'all', label: 'All' },
                ...sprints.map((s) => ({ value: s.id, label: s.isCurrent ? `${s.label} · now` : s.label })),
                { value: 'backlog', label: 'Backlog' },
              ]}
              onChange={(v) => onSprintFilter(v === 'all' ? 'all' : v === 'backlog' ? null : v)}
            />
          </span>
        )}
        <button
          type="button"
          className={`list-mode ${scope === 'roots' ? 'is-on' : ''}`}
          title="Hide sub-tasks; they stay visible as progress on their parent"
          onClick={() => setScope((s) => (s === 'all' ? 'roots' : 'all'))}
        >
          Commitments only
        </button>
        {hiddenSubtasks > 0 && (
          <span className="muted work-note">{hiddenSubtasks} sub-task{hiddenSubtasks === 1 ? '' : 's'} hidden</span>
        )}
        <span className="work-spacer" />
        <ViewSwitcher view={view} onChange={onViewChange} />
      </div>

      {total === 0 && (layout === 'board' || !editable) ? (
        <div className="view-placeholder muted">
          {editable ? 'No tasks yet — add one in a column.' : 'No tasks on this board yet.'}
        </div>
      ) : layout === 'table' ? (
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
          onToggleDone={(id) => useStore.getState().toggleTaskDone(id)}
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
          members={members}
          sprints={sprints}
          tasksById={tasksById}
          editable={editable}
        />
      ) : (
        <WorkBoard
          tabId={tabId}
          groups={groups}
          onDropOn={onDropOn}
          onOpenTask={(id) => navigate(boardTaskPath(tabId, id))}
          onOpenMenu={openMenu}
          addFieldsFor={addFieldsFor}
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
          ids={menu.ids}
          tabId={tabId}
          focusField={menu.field}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
