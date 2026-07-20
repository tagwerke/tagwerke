// The notification feed panel (NOTIFICATIONS.md, Phase 3). Opened from the TopBar/MobileNav bell.
// Lists the latest notifications, lets you mark them read, and navigates to the related board on
// click. Reuses the share-panel modal shell for styling consistency.

import { useStore } from '../store';
import { useNotifications } from '../notifications/useNotifications';
import { PushOptIn } from './PushOptIn';
import { timeAgo } from '../util/dates';
import type { NotificationType } from '../types';

/** A small glyph per notification kind — keeps the list scannable at a glance. */
function NotifIcon({ type }: { type: NotificationType }) {
  switch (type) {
    case 'task_assigned':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13c0-2 2.2-3.2 5-3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M11 11.5h3M12.5 10v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
    case 'review_requested':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
    case 'task_approved':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
    case 'board_added':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 6h11" stroke="currentColor" strokeWidth="1.4"/></svg>;
    default:
      return null;
  }
}

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const items = useNotifications((s) => s.items);
  const unread = useNotifications((s) => s.unread);
  const markRead = useNotifications((s) => s.markRead);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const open = (id: string, tabId: string | null | undefined) => {
    markRead(id);
    if (tabId) {
      setPlannerOpen(false);
      setActiveTab(tabId);
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Notifications</strong>
          <div className="notif-head-actions">
            {unread > 0 && (
              <button className="link-btn" onClick={markAllRead}>Mark all read</button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
          </div>
        </header>

        <PushOptIn />

        <div className="notif-list">
          {items.length === 0 ? (
            <p className="notif-empty">You’re all caught up.</p>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                className={`notif-row ${n.readAt ? '' : 'is-unread'}`}
                onClick={() => open(n.id, n.tabId)}
              >
                <span className="notif-icon" aria-hidden><NotifIcon type={n.type} /></span>
                <span className="notif-text">
                  <span className="notif-title">{n.title}</span>
                  {n.body && <span className="notif-body">{n.body}</span>}
                  <span className="notif-time">{timeAgo(n.createdAt)}</span>
                </span>
                {!n.readAt && <span className="notif-dot" aria-label="unread" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
