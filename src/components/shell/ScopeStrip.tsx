// The scope strip: a full-width row under the top bar in the board grid. Shows the current
// space scope + the filter facets inline (no popover) + a board count. Reuses the exact same
// `filter` state and setFilter toggles as the old FilterPanel — it's the same filter, surfaced
// as a persistent strip instead of a dropdown. (The mobile MoreSheet still opens FilterPanel.)

import { useStore } from '../../store';

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
      <div className="scope-left">
        {scoped ? (
          <span className="scope-current">
            <span className="scope-dot" style={{ background: scoped.color }} />
            {scoped.name}
            <button className="scope-clear-x" title="Clear space scope" onClick={() => setFilter({ projectIds: [] })}>×</button>
          </span>
        ) : (
          <span className="scope-current all">All boards</span>
        )}
      </div>

      <div className="scope-facets">
        {([1, 2, 3] as const).map((p) => (
          <button
            key={p}
            className={`chip chip-priority p${p} ${filter.priorities.includes(p) ? 'active' : ''}`}
            onClick={() => togglePriority(p)}
            title={`priority ${p}`}
          >
            {'!'.repeat(p)}
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
