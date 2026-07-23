// The scope strip: a full-width row under the top bar in the board grid. Shows the current
// space scope + the filter facets inline (no popover) + a board count. Reuses the exact same
// `filter` state and setFilter toggles as the old FilterPanel — it's the same filter, surfaced
// as a persistent strip instead of a dropdown. (The mobile MoreSheet still opens FilterPanel.)

import { useStore } from '../../store';
import { PRIORITY_LABELS } from '../../util/filter';

export function ScopeStrip() {
  const projects = useStore((s) => s.projects);
  const tabs = useStore((s) => s.tabs);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  const scoped = filter.projectIds.length === 1 ? projects[filter.projectIds[0]] : null;
  const boardCount = Object.values(tabs).filter(
    (t) => t.type !== 'today' && (filter.projectIds.length ? filter.projectIds.includes(t.projectId) : true),
  ).length;

  const togglePriority = (p: 1 | 2 | 3) => {
    const xs = filter.priorities.includes(p) ? filter.priorities.filter((x) => x !== p) : [...filter.priorities, p];
    setFilter({ priorities: xs });
  };

  // "Clear" resets the facets but keeps the space scope (which has its own ✕).
  const facetCount = filter.priorities.length + (filter.hasDate ? 1 : 0) + (filter.dueSoon ? 1 : 0) + filter.owners.length + (filter.query ? 1 : 0);
  const clearFacets = () => setFilter({ priorities: [], hasDate: false, dueSoon: false, owners: [], query: '' });

  return (
    <div className="scope-strip">
      <label className="scope-search" title="Filter this list — press Ctrl+K to search everywhere">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        <input
          type="text"
          value={filter.query}
          onChange={(e) => setFilter({ query: e.target.value })}
          placeholder="Filter boards & tasks…"
        />
      </label>

      <div className="scope-facets">
        {/* The space scope is a pill inline with the filter pills — it's the single place the name
            is shown on the grid (the board group header is suppressed when scoped to one space).
            Clicking it un-scopes. */}
        {scoped && (
          <button
            className="chip chip-space"
            title={`Clear ${scoped.name} scope`}
            onClick={() => setFilter({ projectIds: [] })}
          >
            <span className="scope-dot" style={{ background: scoped.color }} />
            {scoped.name}
            <span className="chip-x" aria-hidden>×</span>
          </button>
        )}
        {([1, 2, 3] as const).map((p) => (
          <button
            key={p}
            className={`chip chip-priority p${p} ${filter.priorities.includes(p) ? 'active' : ''}`}
            onClick={() => togglePriority(p)}
            title={`${PRIORITY_LABELS[p]} priority`}
          >
            {PRIORITY_LABELS[p]}
          </button>
        ))}
        <button className={`chip ${filter.hasDate ? 'active' : ''}`} onClick={() => setFilter({ hasDate: !filter.hasDate })}>has date</button>
        <button className={`chip ${filter.dueSoon ? 'active' : ''}`} onClick={() => setFilter({ dueSoon: !filter.dueSoon })}>due soon</button>
      </div>

      <div className="scope-right">
        <span className="scope-count">{boardCount} board{boardCount === 1 ? '' : 's'}</span>
        {facetCount > 0 && <button className="scope-clear" onClick={clearFacets}>Clear</button>}
      </div>
    </div>
  );
}
