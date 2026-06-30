import { useStore } from '../store';
import { useSession } from '../session/useSession';
import type { Panel } from '../App';

// Fixed bottom tab bar — phones only (hidden ≥ 720px via CSS). Primary navigation
// + actions live here, thumb-reachable; secondary actions go in the More sheet.
export function MobileNav({ onOpen }: { onOpen: (panel: Panel) => void }) {
  const activeTabId = useStore((s) => s.activeTabId);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);

  const onHome = () => { setPlannerOpen(false); setActiveTab(null); };
  const onPlanner = () => { setActiveTab(null); setPlannerOpen(true); };

  const isHome = !plannerOpen && !activeTabId;
  const isPlanner = plannerOpen;

  return (
    <nav className="mobile-nav" aria-label="Primary">
      <button className={`mnav-item ${isHome ? 'is-active' : ''}`} onClick={onHome} aria-current={isHome}>
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden><path d="M3 8.5L10 3l7 5.5M5 7.5V16h10V7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <span>board</span>
      </button>
      <button className={`mnav-item ${isPlanner ? 'is-active' : ''}`} onClick={onPlanner} aria-current={isPlanner}>
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden><rect x="3" y="4" width="14" height="13" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M3 8h14M6.5 2.5v3M13.5 2.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        <span>planner</span>
      </button>
      <button className="mnav-item mnav-new" onClick={() => onOpen('new')} aria-label="New tab">
        <span className="mnav-new-circle">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        </span>
      </button>
      <button className="mnav-item" onClick={() => onOpen('search')} aria-label="Search">
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M13.5 13.5l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        <span>search</span>
      </button>
      <button className="mnav-item" onClick={() => onOpen('more')} aria-label="More">
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden><circle cx="4" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="16" cy="10" r="1.6" fill="currentColor"/></svg>
        <span>more</span>
        {needs2fa && <span className="mnav-dot" aria-hidden />}
      </button>
    </nav>
  );
}
