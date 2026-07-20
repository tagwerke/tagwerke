import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { useNotifications } from '../notifications/useNotifications';
import type { Panel } from '../App';

// Overflow sheet for the mobile bottom nav: secondary actions that don't earn a
// permanent tab slot. Slides up from the bottom (styled as a sheet on phones).
export function MoreSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (panel: Panel) => void }) {
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);
  const logout = useSession((s) => s.logout);
  const unread = useNotifications((s) => s.unread);
  const resetFilter = useStore((s) => s.resetFilter);
  const filterCount = useStore((s) => {
    const f = s.filter;
    return (
      f.projectIds.length + f.owners.length + f.priorities.length +
      (f.hasDate ? 1 : 0) + (f.dueSoon ? 1 : 0) + (f.query ? 1 : 0)
    );
  });

  return (
    <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <button className="sheet-row" onClick={() => onOpen('notifications')}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 2a3.5 3.5 0 00-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 008 2zM6.5 12a1.5 1.5 0 003 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>notifications</span>
          {unread > 0 && <span className="sheet-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className="sheet-row" onClick={() => onOpen('filter')}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2 3h12M4 8h8M6 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>filter</span>
          {filterCount > 0 && <span className="sheet-badge">{filterCount}</span>}
        </button>
        {filterCount > 0 && (
          <button className="sheet-row" onClick={() => { resetFilter(); onClose(); }}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
            <span>clear filters</span>
          </button>
        )}
        <button className="sheet-row" onClick={() => onOpen('security')}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 2l5 2v3.5c0 3-2.1 5.3-5 6.5-2.9-1.2-5-3.5-5-6.5V4l5-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M6 8l1.5 1.5L11 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>security</span>
          {needs2fa && <span className="sheet-dot" aria-label="two-factor not set up" />}
        </button>
        <button className="sheet-row danger" onClick={() => void logout()}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M10 2H4v12h6M7 8h7m0 0l-2.5-2.5M14 8l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>sign out</span>
        </button>
      </div>
    </div>
  );
}
