import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { useNotifications } from '../notifications/useNotifications';
import { confirmSignOut } from '../confirm/prompts';
import { useShell } from './shell/useShell';
import type { Panel } from '../App';

// Overflow sheet for the mobile bottom nav: secondary actions that don't earn a
// permanent tab slot. Slides up from the bottom (styled as a sheet on phones).
export function MoreSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (panel: Panel) => void }) {
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);
  const logout = useSession((s) => s.logout);
  const setAppSettings = useShell((s) => s.setAppSettings);
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
          {unread > 0 && <span className="pill pill-solid sheet-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className="sheet-row" onClick={() => onOpen('import')}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 10V2m0 0L5 5m3-3l3 3M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>import CSV</span>
        </button>
        <button className="sheet-row" onClick={() => onOpen('filter')}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2 3h12M4 8h8M6 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>filter</span>
          {filterCount > 0 && <span className="pill pill-solid sheet-badge">{filterCount}</span>}
        </button>
        {filterCount > 0 && (
          <button className="sheet-row" onClick={() => { resetFilter(); onClose(); }}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
            <span>clear filters</span>
          </button>
        )}
        <button className="sheet-row" onClick={() => { setAppSettings(needs2fa ? 'security' : 'spaces'); onClose(); }}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          <span>settings</span>
          {needs2fa && <span className="sheet-dot" aria-label="two-factor not set up" />}
        </button>
        <button
          className="sheet-row danger"
          onClick={() => void confirmSignOut().then((ok) => { if (ok) void logout(); })}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M10 2H4v12h6M7 8h7m0 0l-2.5-2.5M14 8l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>sign out</span>
        </button>
      </div>
    </div>
  );
}
