import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { OfflinePill } from './OfflinePill';
import type { Panel } from '../App';

export function TopBar({ onOpen }: { onOpen: (panel: Panel) => void }) {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const filterCount = useStore((s) => {
    const f = s.filter;
    return (
      f.projectIds.length + f.owners.length + f.priorities.length +
      (f.hasDate ? 1 : 0) + (f.dueSoon ? 1 : 0) + (f.query ? 1 : 0)
    );
  });
  const resetFilter = useStore((s) => s.resetFilter);
  const logout = useSession((s) => s.logout);

  const onHome = () => { setPlannerOpen(false); setActiveTab(null); };

  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} aria-label="Home">
        <span className="brand-mark" />
        <span className="brand-name">do</span>
      </button>

      <OfflinePill />

      <div className="topbar-actions">
        <button className="btn ghost" onClick={() => setPlannerOpen(true)} title="Open the Planner">
          <svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M2 6h12M5 2v2M11 2v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>planner</span>
        </button>
        <button className="btn ghost" onClick={() => onOpen('search')} title="Search (Ctrl+K)">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>search</span>
        </button>
        <button className={`btn ghost ${filterCount ? 'has-filter' : ''}`} onClick={() => onOpen('filter')}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 3h12M4 8h8M6 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>filter{filterCount ? ` · ${filterCount}` : ''}</span>
        </button>
        {filterCount > 0 && (
          <button className="btn ghost tiny" onClick={resetFilter} title="Clear filters">×</button>
        )}
        {isAdmin && (
          <button className="btn ghost" onClick={() => onOpen('admin')} title="Admin dashboard">
            admin
          </button>
        )}
        <button className="btn ghost" onClick={() => onOpen('security')} title="Security & two-factor">
          security
        </button>
        <button className="btn ghost" onClick={() => void logout()} title="Sign out">
          sign out
        </button>
        <button className="btn primary" onClick={() => onOpen('new')}>+ new tab</button>
      </div>

      <div style={{ display: 'none' }}>{activeTabId}</div>
    </header>
  );
}
