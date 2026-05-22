import { useMemo } from 'react';
import { useStore } from '../store';
import { TabCard } from './TabCard';
import { Masonry } from './Masonry';
import { isDueSoon } from '../util/dates';

export function Board() {
  const tabs = useStore((s) => s.tabs);
  const tabOrder = useStore((s) => s.tabOrder);
  const todayTabId = useStore((s) => s.todayTabId);
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
      if (q && !tab.name.toLowerCase().includes(q) && !tabTasks.some((t) => t.text.toLowerCase().includes(q))) {
        return false;
      }

      if (filter.owners.length || filter.priorities.length || filter.hasDate || filter.dueSoon) {
        const matched = tabTasks.some((t) => {
          if (filter.owners.length && !(t.owner && filter.owners.includes(t.owner))) return false;
          if (filter.priorities.length && !(t.priority && filter.priorities.includes(t.priority))) return false;
          if (filter.hasDate && !t.date) return false;
          if (filter.dueSoon && !(t.date && isDueSoon(t.date))) return false;
          return true;
        });
        if (!matched) return false;
      }
      return true;
    };
  }, [tabs, tasks, filter]);

  const groupByProject = filter.projectIds.length > 0;

  const grouped = useMemo(() => {
    const out: Array<{ projectId: string; tabIds: string[] }> = [];
    for (const pid of projectOrder) {
      const tabIds = tabOrder.filter((tid) => tabs[tid]?.projectId === pid && tid !== todayTabId && passes(tid));
      if (tabIds.length) out.push({ projectId: pid, tabIds });
    }
    return out;
  }, [projectOrder, tabOrder, tabs, todayTabId, passes]);

  const allTabIds = useMemo(
    () => tabOrder.filter((tid) => tid !== todayTabId && passes(tid)),
    [tabOrder, todayTabId, passes]
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
