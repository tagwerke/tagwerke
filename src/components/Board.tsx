import { useMemo } from 'react';
import { useStore } from '../store';
import { TabCard } from './TabCard';
import { Masonry } from './Masonry';
import { matchesFilters } from './board/workFilters';
import { extractDocText } from '../util/docText';

export function Board() {
  const tabs = useStore((s) => s.tabs);
  const tabOrder = useStore((s) => s.tabOrder);
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);

  const passes = useMemo(() => {
    // The task facets; the search text is matched against the board as a whole, below.
    const facets = { ...filter, sprints: [], query: '' };
    const facetsOn = filter.assignees.length > 0 || filter.statuses.length > 0 || filter.priorities.length > 0;
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

      if (facetsOn && !tabTasks.some((t) => matchesFilters(t, facets))) return false;
      return true;
    };
  }, [tabs, tasks, filter]);

  // Latest updated first. A board's freshness is the newer of its own update time (notes, renames,
  // anything saved on the server) and its newest task's — the tasks cover edits made since the
  // page loaded. Ties fall back to creation order, newest created first.
  const byRecency = useMemo(() => {
    const updated: Record<string, number> = {};
    for (const t of Object.values(tabs)) updated[t.id] = t.updatedAt ?? 0;
    for (const t of Object.values(tasks)) {
      const ts = t.updatedAt ?? t.createdAt ?? 0;
      if (ts > (updated[t.homeTabId] ?? 0)) updated[t.homeTabId] = ts;
    }
    const orderIndex = new Map(tabOrder.map((id, i) => [id, i]));
    return (a: string, b: string): number => {
      const diff = (updated[b] ?? 0) - (updated[a] ?? 0);
      if (diff) return diff;
      return (orderIndex.get(b) ?? 0) - (orderIndex.get(a) ?? 0);
    };
  }, [tabs, tasks, tabOrder]);

  const tabIds = useMemo(
    () => tabOrder.filter((tid) => passes(tid)).sort(byRecency),
    [tabOrder, passes, byRecency]
  );

  if (tabIds.length === 0) {
    return (
      <section className="board empty">
        <p>no tabs match. <button className="link-btn" onClick={() => useStore.getState().resetFilter()}>clear filters</button></p>
      </section>
    );
  }

  return (
    <section className="board">
      <Masonry>
        {tabIds.map((tid) => (
          <TabCard tabId={tid} key={tid} />
        ))}
      </Masonry>
    </section>
  );
}
