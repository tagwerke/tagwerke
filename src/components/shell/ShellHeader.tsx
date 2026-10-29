// The header: everything about what is on screen, plus the app's own tools. It is the old top bar
// and the board's title row merged into one place — back, the board's space and name, who is here,
// Share, star, the board menu; then search, notifications, import, a new board, and your
// account. Drawn as a row in the top bar or a column in the sidebar; the tabs take the other bar.

import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { useNotifications } from '../../notifications/useNotifications';
import { usePresence } from '../../realtime/usePresence';
import { hexToRgba } from '../../util/color';
import { Avatar } from '../common/Avatar';
import { Dropdown } from '../Dropdown';
import { BoardMenu } from '../board/BoardMenu';
import { OfflinePill } from '../OfflinePill';
import { ProfileDrawer } from './ProfileDrawer';
import type { Orientation } from './NavTabs';
import type { Panel } from '../../App';
import type { Tab } from '../../types';

/** Live cursors present in this board, as ringed avatars (self excluded, deduped by name). They
 *  open People: who is here now is the first thing that list is about. */
function PresenceAvatars({ tabId, onOpen }: { tabId: string; onOpen: () => void }) {
  const peers = usePresence(tabId).filter((p) => !p.self);
  const seen = new Set<string>();
  const uniq = peers.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
  if (!uniq.length) return null;
  return (
    <button className="icon-btn presence avatar-stack" onClick={onOpen} title={`${uniq.length} editing now`} aria-label={`${uniq.length} editing now. Open People`}>
      {uniq.slice(0, 4).map((p) => (
        <Avatar key={p.clientId} name={p.name} color={p.color} size={26} ring title={`${p.name} — here now`} />
      ))}
    </button>
  );
}

/** The open board's part of the header: its space, its name, and its own controls. Everything else
 *  about the board is in its settings, which these open — Share and the avatars at People, the ⋯
 *  menu at the rest. */
function BoardContext({ tab }: { tab: Tab }) {
  const project = useStore((s) => s.projects[tab.projectId]);
  const projects = useStore((s) => s.projects);
  const renameTab = useStore((s) => s.renameTab);
  const setTabStarred = useStore((s) => s.setTabStarred);
  const setTabProject = useStore((s) => s.setTabProject);
  const openBoardSettings = useStore((s) => s.openBoardSettings);
  const projectOptions = useMemo(
    () => Object.values(projects)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ value: p.id, label: p.name, accent: p.color })),
    [projects],
  );
  // The title as it stood when editing began, so an emptied field can be put back on blur.
  const titleOnFocus = useRef(tab.name);

  const isBoard = tab.type !== 'today';
  const accent = project?.color ?? '#888';
  const style = { '--page-accent': accent, '--page-accent-soft': hexToRgba(accent, 0.1) } as React.CSSProperties;

  return (
    <div className="shell-board" style={style}>
      <div className="shell-board-title">
        {/* The space is a choice, not a label: a board moves between spaces from inside itself
            rather than only from the grid it is filed in. */}
        {isBoard && projectOptions.length > 0 ? (
          <Dropdown
            className="is-chip"
            value={tab.projectId}
            options={projectOptions}
            onChange={(id) => setTabProject(tab.id, id)}
            placeholder="Space"
          />
        ) : project ? (
          <span className="board-eyebrow">{project.name}</span>
        ) : null}
        <input
          className="board-title"
          value={tab.name}
          onFocus={() => { titleOnFocus.current = tab.name; }}
          onChange={(e) => renameTab(tab.id, e.target.value)}
          // A board must have a name (both PATCH routes require one), so an emptied field is an
          // editing state, not a value: nothing was sent for it, and leaving it would strand the
          // store on a blank the next re-pull would silently overwrite. Put back whatever was
          // there on focus — which is also correct if a different name was typed and sent first.
          onBlur={() => { if (!tab.name.trim()) renameTab(tab.id, titleOnFocus.current); }}
          aria-label="board title"
        />
      </div>
      <div className="shell-board-controls">
        {isBoard && <PresenceAvatars tabId={tab.id} onOpen={() => openBoardSettings(tab.id, 'people')} />}
        {isBoard && (
          <button className="btn primary" onClick={() => openBoardSettings(tab.id, 'people')}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
              <path d="M6 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 13.5c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4M12.5 5v4M10.5 7h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>Share</span>
          </button>
        )}
        <button
          className={`icon-btn star ${tab.starred ? 'on' : ''}`}
          onClick={() => setTabStarred(tab.id, !tab.starred)}
          aria-label="star"
          title={tab.starred ? 'unstar' : 'star'}
        >
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.7l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.6l-3.9 1.9.9-4.3-3.3-3 4.4-.5z" fill={tab.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        {isBoard && <BoardMenu tabId={tab.id} />}
      </div>
    </div>
  );
}

function Account({ orientation }: { orientation: Orientation }) {
  const me = useSession((s) => s.user);
  const needs2fa = useSession((s) => !!s.user && !s.user.totpEnabled);
  const [open, setOpen] = useState(false);
  if (!me) return null;
  return (
    <div className="sidebar-account-wrap">
      <button
        className="sidebar-account"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
        title={me.email}
        aria-label="Account"
      >
        <Avatar name={me.email} size={26} />
        <span className="sidebar-account-email">{me.email.split('@')[0]}</span>
        {needs2fa && <span className="nav-dot" aria-label="two-factor not set up" />}
      </button>
      {open && (
        <ProfileDrawer email={me.email} below={orientation === 'row'} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

export function ShellHeader({ orientation, onOpen }: { orientation: Orientation; onOpen: (panel: Panel) => void }) {
  const tab = useStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const unread = useNotifications((s) => s.unread);

  return (
    <header className={`topbar main-topbar shell-header is-${orientation}`}>
      {tab && (
        <button className="btn ghost topbar-back" onClick={() => setActiveTab(null)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span>Boards</span>
        </button>
      )}
      {tab && <BoardContext tab={tab} />}
      <OfflinePill />

      <div className="topbar-actions">
        <div className="topbar-utility">
          <button className="btn ghost" onClick={() => onOpen('search')} title="Search (Ctrl+K)">
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            <span>search</span>
          </button>
          <button className="btn ghost notif-bell" onClick={() => onOpen('notifications')} title="Notifications" aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M8 2a3.5 3.5 0 00-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 008 2zM6.5 12a1.5 1.5 0 003 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span className="shell-label">notifications</span>
            {unread > 0 && <span className="pill pill-solid notif-badge">{unread > 9 ? '9+' : unread}</span>}
          </button>
        </div>
        <span className="topbar-divider" aria-hidden />
        <button className="btn ghost" onClick={() => onOpen('import')} title="Import CSV">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M8 10V2m0 0L5 5m3-3l3 3M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>Import CSV</span>
        </button>
        <button className="btn primary btn-new-tab" onClick={() => onOpen('new')}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          <span>New board</span>
        </button>
        <Account orientation={orientation} />
      </div>
    </header>
  );
}
