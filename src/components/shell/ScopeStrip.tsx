// The scope strip: a full-width row under the top bar in the board grid. The search box (with the
// filter menu behind its button, the same component the board uses) and one pill per space.
// No space picked means every space; picking several shows their boards together.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { PRIORITY_LABELS } from '../../util/filter';
import { UNASSIGNED } from '../board/workFilters';
import { DEFAULT_STATES, visible as visibleStates } from '../../../shared/status';
import { FilterSearch } from '../common/FilterSearch';
import { MultiSelect } from '../common/MultiSelect';

const PRIORITIES = ['1', '2', '3'] as const;

export function ScopeStrip() {
  const projects = useStore((s) => s.projects);
  const projectOrder = useStore((s) => s.projectOrder);
  const tabs = useStore((s) => s.tabs);
  const statesByBoard = useStore((s) => s.statesByBoard);
  const membersByBoard = useStore((s) => s.membersByBoard);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  const boardCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of Object.values(tabs)) if (t.type !== 'today') counts[t.projectId] = (counts[t.projectId] ?? 0) + 1;
    return counts;
  }, [tabs]);
  const total = Object.values(boardCount).reduce((a, b) => a + b, 0);

  const toggleSpace = (id: string) => setFilter({
    projectIds: filter.projectIds.includes(id) ? filter.projectIds.filter((x) => x !== id) : [...filter.projectIds, id],
  });

  // Boards define their own states; a state is offered once, by its key, under the first label seen.
  const statusOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const t of Object.values(tabs)) {
      if (t.type === 'today') continue;
      for (const st of visibleStates(statesByBoard[t.id] ?? DEFAULT_STATES)) if (!byKey.has(st.key)) byKey.set(st.key, st.label);
    }
    return [...byKey].map(([value, label]) => ({ value, label }));
  }, [tabs, statesByBoard]);

  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const members of Object.values(membersByBoard)) for (const m of members) byId.set(m.id, m.name);
    return [...byId].map(([value, label]) => ({ value, label })).concat({ value: UNASSIGNED, label: 'Unassigned' });
  }, [membersByBoard]);

  const togglePriority = (p: string) => setFilter({
    priorities: filter.priorities.includes(p) ? filter.priorities.filter((x) => x !== p) : [...filter.priorities, p],
  });

  const menuCount = [filter.statuses, filter.assignees, filter.priorities].filter((l) => l.length > 0).length;
  const clearMenu = () => setFilter({ statuses: [], assignees: [], priorities: [] });
  // "Clear" resets the search and filters but keeps the spaces, which are picked right beside it.
  const clearAll = () => setFilter({ statuses: [], assignees: [], priorities: [], query: '' });

  return (
    <div className="scope-strip">
      <FilterSearch
        query={filter.query}
        onQuery={(query) => setFilter({ query })}
        label="Search boards and tasks"
        menuTitle="Status, assignee and priority filters"
        menuCount={menuCount}
        onClearMenu={clearMenu}
      >
        <div className="work-filter-row">
          <span>Status</span>
          <MultiSelect
            label="Filter by status"
            noun="statuses"
            options={statusOptions}
            selected={filter.statuses}
            onChange={(statuses) => setFilter({ statuses })}
          />
        </div>
        <div className="work-filter-row">
          <span>Assignee</span>
          <MultiSelect
            label="Filter by assignee"
            noun="people"
            options={assigneeOptions}
            selected={filter.assignees}
            onChange={(assignees) => setFilter({ assignees })}
          />
        </div>
        <div className="work-filter-row">
          <span>Priority</span>
          <div className="work-filter-pills">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                className={`pill pill-priority p${p}`}
                aria-pressed={filter.priorities.includes(p)}
                onClick={() => togglePriority(p)}
                title={`${PRIORITY_LABELS[Number(p) as 1 | 2 | 3]} priority`}
              >
                {PRIORITY_LABELS[Number(p) as 1 | 2 | 3]}
              </button>
            ))}
          </div>
        </div>
      </FilterSearch>

      <div className="scope-facets" role="group" aria-label="Spaces">
        <button type="button" className="pill" aria-pressed={filter.projectIds.length === 0} onClick={() => setFilter({ projectIds: [] })}>
          All <span className="work-status-count">{total}</span>
        </button>
        {projectOrder.filter((id) => projects[id]).map((id) => (
          <button
            key={id}
            type="button"
            className="pill pill-project"
            style={{ '--pill-color': projects[id].color } as React.CSSProperties}
            aria-pressed={filter.projectIds.includes(id)}
            onClick={() => toggleSpace(id)}
          >
            {projects[id].name} <span className="work-status-count">{boardCount[id] ?? 0}</span>
          </button>
        ))}
      </div>

      {(menuCount > 0 || filter.query) && (
        <div className="scope-right">
          <button type="button" className="scope-clear" onClick={clearAll}>Clear</button>
        </div>
      )}
    </div>
  );
}
