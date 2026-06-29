import { useState } from 'react';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { NewTabDialog } from './NewTabDialog';
import { FilterPanel } from './FilterPanel';
import { SearchPalette } from './SearchPalette';
import { AdminPanel } from './AdminPanel';

export function TopBar() {
  const [newOpen, setNewOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const freezeToday = useStore((s) => s.freezeToday);
  const todayTabId = useStore((s) => s.todayTabId);
  const filterCount = useStore((s) => {
    const f = s.filter;
    return (
      f.projectIds.length + f.owners.length + f.priorities.length +
      (f.hasDate ? 1 : 0) + (f.dueSoon ? 1 : 0) + (f.query ? 1 : 0)
    );
  });
  const resetFilter = useStore((s) => s.resetFilter);
  const logout = useSession((s) => s.logout);

  const onHome = () => setActiveTab(null);
  const onFreeze = () => {
    if (!confirm('Freeze the current TODAY into a snapshot and clear it for a new day?')) return;
    freezeToday();
    setActiveTab(todayTabId);
  };

  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} aria-label="Home">
        <span className="brand-mark" />
        <span className="brand-name">do</span>
      </button>

      <div className="topbar-actions">
        <button className="btn ghost" onClick={() => setPlannerOpen(true)} title="Open the Planner">
          <svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M2 6h12M5 2v2M11 2v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>planner</span>
        </button>
        <button className="btn ghost" onClick={() => setSearchOpen(true)} title="Search (Ctrl+K)">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>search</span>
        </button>
        <button className={`btn ghost ${filterCount ? 'has-filter' : ''}`} onClick={() => setFilterOpen((v) => !v)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 3h12M4 8h8M6 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>filter{filterCount ? ` · ${filterCount}` : ''}</span>
        </button>
        {filterCount > 0 && (
          <button className="btn ghost tiny" onClick={resetFilter} title="Clear filters">×</button>
        )}
        <button className="btn ghost" onClick={onFreeze} title="Freeze TODAY into a snapshot">
          freeze
        </button>
        {isAdmin && (
          <button className="btn ghost" onClick={() => setAdminOpen(true)} title="Admin dashboard">
            admin
          </button>
        )}
        <button className="btn ghost" onClick={() => void logout()} title="Sign out">
          sign out
        </button>
        <button className="btn primary" onClick={() => setNewOpen(true)}>+ new tab</button>
      </div>

      {newOpen && <NewTabDialog onClose={() => setNewOpen(false)} />}
      {filterOpen && <FilterPanel onClose={() => setFilterOpen(false)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
      <div style={{ display: 'none' }}>{activeTabId}</div>
    </header>
  );
}
