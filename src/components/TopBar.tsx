import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { useNotifications } from '../notifications/useNotifications';
import { OfflinePill } from './OfflinePill';
import type { Panel } from '../App';

export function TopBar({ onOpen }: { onOpen: (panel: Panel) => void }) {
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);
  const activeTabId = useStore((s) => s.activeTabId);
  const unread = useNotifications((s) => s.unread);
  const logout = useSession((s) => s.logout);

  return (
    <header className="topbar main-topbar">
      <OfflinePill />

      <div className="topbar-actions">
        <button className="btn ghost" onClick={() => onOpen('search')} title="Search (Ctrl+K)">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <span>search</span>
        </button>
        <button className="btn ghost notif-bell" onClick={() => onOpen('notifications')} title="Notifications" aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M8 2a3.5 3.5 0 00-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 008 2zM6.5 12a1.5 1.5 0 003 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className="btn ghost" onClick={() => onOpen('security')} title={needs2fa ? 'Security — two-factor not set up' : 'Security & two-factor'}>
          security
          {needs2fa && <span className="nav-dot" aria-label="two-factor not set up" />}
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
