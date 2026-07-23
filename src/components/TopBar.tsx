import { useStore } from '../store';
import { useNotifications } from '../notifications/useNotifications';
import { useHelpBadge } from '../help/useHelpBadge';
import { OfflinePill } from './OfflinePill';
import type { Panel } from '../App';

export function TopBar({ onOpen }: { onOpen: (panel: Panel) => void }) {
  const activeTabId = useStore((s) => s.activeTabId);
  const unread = useNotifications((s) => s.unread);
  const { hasNew: hasNewHelp } = useHelpBadge();
  // No board open (grid or calendar) is exactly when a board isn't the active tab — that's the
  // only place the "?" belongs in the top bar; once a board is open the board toolbar has its own.
  const noBoardOpen = activeTabId == null;

  return (
    <header className="topbar main-topbar">
      <OfflinePill />

      <div className="topbar-actions">
        <div className="topbar-utility">
          <button className="btn ghost" onClick={() => onOpen('search')} title="Search (Ctrl+K)">
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span>search</span>
          </button>
          {noBoardOpen && (
            <button className="btn ghost topbar-help" onClick={() => onOpen('help')} aria-label="how to use Tagwerke" title="How to use Tagwerke">
              <span>?</span>
              {hasNewHelp && <span className="help-btn-dot" aria-label="new" />}
            </button>
          )}
          <button className="btn ghost notif-bell" onClick={() => onOpen('notifications')} title="Notifications" aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M8 2a3.5 3.5 0 00-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 008 2zM6.5 12a1.5 1.5 0 003 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
          </button>
        </div>
        <span className="topbar-divider" aria-hidden />
        <button className="btn primary btn-new-tab" onClick={() => onOpen('new')}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          <span>New tab</span>
        </button>
      </div>
    </header>
  );
}
