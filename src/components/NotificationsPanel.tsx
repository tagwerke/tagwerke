// The notification feed panel (NOTIFICATIONS.md, Phase 3). Opened from the TopBar/MobileNav bell.
// Lists the latest notifications, lets you mark them read, and navigates to the related board on
// click. Uses the shared modal shell; push opt-in and Clear live in the footer so the feed leads.

import { useStore } from '../store';
import { useNotifications } from '../notifications/useNotifications';
import { askConfirm } from '../confirm/useConfirm';
import { PushOptIn } from './PushOptIn';
import { timeAgo } from '../util/dates';
import type { Notification, NotificationType } from '../types';
import { EmptyState } from './common/EmptyState';
import { navigate } from '../util/router';
import { notificationPath } from '../../shared/links';

/** A small glyph per notification kind — keeps the list scannable at a glance. */
function NotifIcon({ type }: { type: NotificationType }) {
  switch (type) {
    case 'task_assigned':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M8 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13c0-2 2.2-3.2 5-3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M11 11.5h3M12.5 10v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
    case 'review_requested':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
    case 'task_approved':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
    case 'token_created':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><circle cx="5.5" cy="10.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M7.4 8.6L13 3M11 5l1.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
    case 'board_added':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M2.5 6h11" stroke="currentColor" strokeWidth="1.4"/></svg>;
    // Both comment kinds share the speech bubble — the headline already says which one it is
    // ("Mentioned you on…" vs "New comment on…"), and two near-identical glyphs would only make
    // the list harder to scan, not easier.
    case 'comment_mention':
    case 'comment_added':
      return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h7.8c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H6.4l-3 2.2v-2.2h-.9z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>;
    default:
      return null;
  }
}

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const items = useNotifications((s) => s.items);
  const unread = useNotifications((s) => s.unread);
  const markRead = useNotifications((s) => s.markRead);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clearAll = useNotifications((s) => s.clearAll);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const open = (n: Notification) => {
    markRead(n.id);
    if (n.taskId && n.tabId) {
      // Straight to the task page (and the comment on it). The URL drives the rest, as for a pasted link.
      setPlannerOpen(false);
      navigate(notificationPath(n));
    } else if (n.tabId) {
      setPlannerOpen(false);
      setActiveTab(n.tabId);
    }
    onClose();
  };

  const confirmClear = () =>
    void askConfirm({
      title: 'Clear all notifications?',
      body: (
        <p>
          {items.length === 1 ? 'The one notification' : `All ${items.length} notifications`} in your
          feed {items.length === 1 ? 'is' : 'are'} deleted. The work they point at is untouched.
        </p>
      ),
      confirmLabel: 'Clear feed',
    }).then((ok) => {
      if (ok) clearAll();
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-scroll" role="dialog" aria-modal="true" aria-label="Notifications" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Notifications</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {items.length > 0 && (
          <div className="notif-bar">
            <span className="count">{unread > 0 ? `${unread} unread` : 'All read'}</span>
            {unread > 0 && <button className="link-btn" onClick={markAllRead}>Mark all read</button>}
          </div>
        )}

        <div className="notif-list">
          {items.length === 0 ? (
            <EmptyState size="block" as="p">You’re all caught up.</EmptyState>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                className={`notif-row ${n.readAt ? '' : 'is-unread'}`}
                onClick={() => open(n)}
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

        <footer className="notif-foot">
          <PushOptIn />
          {items.length > 0 && <button className="row-action danger" onClick={confirmClear}>Clear all</button>}
        </footer>
      </div>
    </div>
  );
}
