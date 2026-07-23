import { useMemo } from 'react';
import { useStore } from '../store';
import { TabCard } from './TabCard';
import { Masonry } from './Masonry';
import { matchesTaskFacets } from '../util/filter';
import { extractDocText } from '../util/docText';

export function Board() {
  const tabs = useStore((s) => s.tabs);
  const tabOrder = useStore((s) => s.tabOrder);
  const projects = useStore((s) => s.projects);
  const projectOrder = useStore((s) => s.projectOrder);
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const deleteProject = useStore((s) => s.deleteProject);

  const passes = useMemo(() => {
    return (tabId: string): boolean => {
      const tab = tabs[tabId];
      if (!tab || tab.type === 'today') return false;

      if (filter.projectIds.length && !filter.projectIds.includes(tab.projectId)) {
        return false;
      }
      const tabTasks = Object.values(tasks).filter((t) => t.homeTabId === tabId);

      const q = filter.query.trim().toLowerCase();
      if (q) {
        const matchesName = tab.name.toLowerCase().includes(q);
        const matchesTask = tabTasks.some((t) => t.text.toLowerCase().includes(q));
        const matchesDoc = !matchesName && !matchesTask && extractDocText(tab.docJSON).toLowerCase().includes(q);
        if (!matchesName && !matchesTask && !matchesDoc) return false;
      }

      if (filter.owners.length || filter.priorities.length || filter.hasDate || filter.dueSoon) {
        const matched = tabTasks.some((t) => matchesTaskFacets(t, filter));
        if (!matched) return false;
      }
      return true;
    };
  }, [tabs, tasks, filter]);

  // Group (with per-space headers) only when MORE THAN ONE space is in view. When scoped to a
  // single space, its name is already shown once in the ScopeStrip pill, so a group header would
  // just repeat it as a second strip — render the boards flat instead.
  const groupByProject = filter.projectIds.length > 1;

  // Order boards by most-recently-updated first: a board's freshness is the newest updatedAt
  // among its tasks (tabs carry no timestamp). Boards with no task activity fall back to
  // creation order (newest created first), via the tabOrder index.
  const byRecency = useMemo(() => {
    const lastUpdated: Record<string, number> = {};
    for (const t of Object.values(tasks)) {
      const ts = t.updatedAt ?? t.createdAt ?? 0;
      if (ts > (lastUpdated[t.homeTabId] ?? 0)) lastUpdated[t.homeTabId] = ts;
    }
    const orderIndex = new Map(tabOrder.map((id, i) => [id, i]));
    return (a: string, b: string): number => {
      const diff = (lastUpdated[b] ?? 0) - (lastUpdated[a] ?? 0);
      if (diff) return diff; // latest updated first
      return (orderIndex.get(b) ?? 0) - (orderIndex.get(a) ?? 0); // tie: latest created first
    };
  }, [tasks, tabOrder]);

  const grouped = useMemo(() => {
    const out: Array<{ projectId: string; tabIds: string[] }> = [];
    for (const pid of projectOrder) {
      const tabIds = tabOrder.filter((tid) => tabs[tid]?.projectId === pid && passes(tid)).sort(byRecency);
      if (tabIds.length) out.push({ projectId: pid, tabIds });
    }
    return out;
  }, [projectOrder, tabOrder, tabs, passes, byRecency]);

  const allTabIds = useMemo(
    () => tabOrder.filter((tid) => passes(tid)).sort(byRecency),
    [tabOrder, passes, byRecency]
  );

  if (allTabIds.length === 0) {
    return (
      <section className="board empty">
        <p>no tabs match. <button className="link-btn" onClick={() => useStore.getState().resetFilter()}>clear filters</button></p>
      </section>
    );
  }

  if (!groupByProject) {
    return (
      <section className="board">
        <Masonry>
          {allTabIds.map((tid) => (
            <TabCard tabId={tid} key={tid} />
          ))}
        </Masonry>
      </section>
    );
  }

  return (
    <section className="board">
      {grouped.map(({ projectId, tabIds }) => {
        const project = projects[projectId];
        return (
          <div className="board-group" key={projectId}>
            <header className="board-group-head">
              <span className="board-group-dot" style={{ background: project?.color }} />
              <span className="board-group-name">{project?.name}</span>
              <span className="board-group-count">{tabIds.length}</span>
              <button
                className="icon-btn delete board-group-delete"
                onClick={() => {
                  if (confirm(`Delete project "${project?.name}" and all its tabs?`)) {
                    deleteProject(projectId);
                  }
                }}
                aria-label="delete project"
                title="delete project"
              >
                <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
              </button>
            </header>
            <Masonry>
              {tabIds.map((tid) => (
                <TabCard tabId={tid} key={tid} />
              ))}
            </Masonry>
          </div>
        );
      })}
    </section>
  );
}
