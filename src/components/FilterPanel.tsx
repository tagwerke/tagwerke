import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { confirmDeleteSpace } from '../confirm/prompts';
import { PRIORITY_LABELS } from '../util/filter';

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
        <div className="pill-row">
          {projectOrder.map((pid) => {
            const p = projects[pid];
            if (!p) return null;
            const active = filter.projectIds.includes(pid);
            const isLast = projectOrder.length <= 1;
            const tabCount = Object.values(tabs).filter((t) => t.projectId === pid && t.type !== 'today').length;
            return (
              <span key={pid} className="pill-project-wrap">
                <button
                  className="pill pill-project"
                  aria-pressed={active}
                  style={{ '--pill-color': p.color } as React.CSSProperties}
                  onClick={() => toggleProject(pid)}
                >
                  {p.name}
                </button>
                {!isLast && (
                  <button
                    className="icon-btn delete pill-delete"
                    aria-label={`delete project ${p.name}`}
                    title="delete project"
                    onClick={() => {
                      void confirmDeleteSpace(p.name, tabCount).then((ok) => {
                        if (!ok) return;
                        deleteProject(pid);
                        if (filter.projectIds.includes(pid)) {
                          setFilter({ projectIds: filter.projectIds.filter((x) => x !== pid) });
                        }
                      });
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
          <div className="pill-row">
            {owners.map((o) => (
              <button key={o} className="pill pill-owner" aria-pressed={filter.owners.includes(o)} onClick={() => toggleOwner(o)}>{o}</button>
            ))}
          </div>
        </div>
      )}
      <div className="popover-row">
        <strong>priority</strong>
        <div className="pill-row">
          {([1, 2, 3] as const).map((p) => (
            <button key={p} className={`pill pill-priority p${p}`} aria-pressed={filter.priorities.includes(p)} onClick={() => togglePriority(p)}>{PRIORITY_LABELS[p]}</button>
          ))}
        </div>
      </div>
      <div className="popover-row">
        <strong>dates</strong>
        <div className="pill-row">
          <button className="pill" aria-pressed={filter.hasDate} onClick={() => setFilter({ hasDate: !filter.hasDate })}>has date</button>
          <button className="pill" aria-pressed={filter.dueSoon} onClick={() => setFilter({ dueSoon: !filter.dueSoon })}>due soon</button>
        </div>
      </div>
      <div className="popover-actions">
        <button className="btn ghost tiny" onClick={resetFilter}>clear</button>
        <button className="btn ghost tiny" onClick={onClose}>close</button>
      </div>
    </div>
  );
}
