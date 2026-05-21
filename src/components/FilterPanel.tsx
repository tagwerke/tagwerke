import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';

export function FilterPanel({ onClose }: { onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const projects = useStore((s) => s.projects);
  const projectOrder = useStore((s) => s.projectOrder);
  const tabs = useStore((s) => s.tabs);
  const tasks = useStore((s) => s.tasks);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const deleteProject = useStore((s) => s.deleteProject);

  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const t of Object.values(tasks)) if (t.owner) set.add(t.owner);
    return Array.from(set).sort();
  }, [tasks]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (rootRef.current?.contains(t)) return;
      // Ignore clicks on the topbar filter toggle itself — it has its own handler.
      if (t.closest('.btn')?.textContent?.includes('filter')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const toggleProject = (pid: string) => {
    const ids = filter.projectIds.includes(pid)
      ? filter.projectIds.filter((x) => x !== pid)
      : [...filter.projectIds, pid];
    setFilter({ projectIds: ids });
  };
  const toggleOwner = (o: string) => {
    const xs = filter.owners.includes(o)
      ? filter.owners.filter((x) => x !== o)
      : [...filter.owners, o];
    setFilter({ owners: xs });
  };
  const togglePriority = (p: 1 | 2 | 3) => {
    const xs = filter.priorities.includes(p)
      ? filter.priorities.filter((x) => x !== p)
      : [...filter.priorities, p];
    setFilter({ priorities: xs });
  };

  return (
    <div className="popover" ref={rootRef}>
      <div className="popover-row">
        <strong>project</strong>
        <div className="chip-row">
          {projectOrder.map((pid) => {
            const p = projects[pid];
            if (!p) return null;
            const active = filter.projectIds.includes(pid);
            const isLast = projectOrder.length <= 1;
            const tabCount = Object.values(tabs).filter((t) => t.projectId === pid && t.type !== 'today').length;
            return (
              <span key={pid} className="chip-project-wrap">
                <button
                  className={`chip chip-project ${active ? 'active' : ''}`}
                  style={{ '--chip-color': p.color } as React.CSSProperties}
                  onClick={() => toggleProject(pid)}
                >
                  {p.name}
                </button>
                {!isLast && (
                  <button
                    className="icon-btn delete chip-delete"
                    aria-label={`delete project ${p.name}`}
                    title="delete project"
                    onClick={() => {
                      const msg = tabCount
                        ? `Delete project "${p.name}" and its ${tabCount} tab${tabCount === 1 ? '' : 's'}?`
                        : `Delete project "${p.name}"?`;
                      if (confirm(msg)) {
                        deleteProject(pid);
                        if (filter.projectIds.includes(pid)) {
                          setFilter({ projectIds: filter.projectIds.filter((x) => x !== pid) });
                        }
                      }
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>
      {owners.length > 0 && (
        <div className="popover-row">
          <strong>owner</strong>
          <div className="chip-row">
            {owners.map((o) => (
              <button key={o} className={`chip chip-owner ${filter.owners.includes(o) ? 'active' : ''}`} onClick={() => toggleOwner(o)}>{o}</button>
            ))}
          </div>
        </div>
      )}
      <div className="popover-row">
        <strong>priority</strong>
        <div className="chip-row">
          {([1, 2, 3] as const).map((p) => (
            <button key={p} className={`chip chip-priority p${p} ${filter.priorities.includes(p) ? 'active' : ''}`} onClick={() => togglePriority(p)}>{'!'.repeat(p)}</button>
          ))}
        </div>
      </div>
      <div className="popover-row">
        <strong>dates</strong>
        <div className="chip-row">
          <button className={`chip ${filter.hasDate ? 'active' : ''}`} onClick={() => setFilter({ hasDate: !filter.hasDate })}>has date</button>
          <button className={`chip ${filter.dueSoon ? 'active' : ''}`} onClick={() => setFilter({ dueSoon: !filter.dueSoon })}>due soon</button>
        </div>
      </div>
      <div className="popover-actions">
        <button className="btn ghost tiny" onClick={resetFilter}>clear</button>
        <button className="btn ghost tiny" onClick={onClose}>close</button>
      </div>
    </div>
  );
}
