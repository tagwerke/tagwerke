// The tabs: what you are working on, and one click to switch. Two fixed tabs (All boards, Calendar),
// then every board you have opened, in the order you opened it, each closable like a browser tab.
// Drawn as a column in the sidebar or a strip in the top bar; the layout setting picks which, and the
// header takes the other bar (useShell).
//
// The column reuses the sidebar's row classes; the strip has its own.

import type { ReactNode } from 'react';
import { useStore } from '../../store';
import { useShell } from './useShell';

export type Orientation = 'row' | 'col';

const CLASSES = {
  col: { item: 'space', main: 'space-main', name: 'space-name', close: 'space-gear' },
  row: { item: 'navtab', main: 'navtab-main', name: 'navtab-name', close: 'navtab-close' },
};

const HOME_ICON = (
  <svg className="navtab-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <rect x="2" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="9" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="2" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="9" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
const CALENDAR_ICON = (
  <svg className="navtab-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export function NavTabs({ orientation }: { orientation: Orientation }) {
  const openIds = useShell((s) => s.openIds);
  const closeTab = useShell((s) => s.closeTab);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const activeTabId = useStore((s) => s.activeTabId);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const c = CLASSES[orientation];
  const open = openIds.filter((id) => tabs[id]);

  const item = (key: string, label: string, mark: ReactNode, on: boolean, go: () => void, close?: () => void) => (
    <div key={key} className={`${c.item} ${on ? 'on' : ''} ${close ? '' : 'is-fixed'}`}>
      <button
        type="button"
        className={c.main}
        aria-current={on ? 'page' : undefined}
        onClick={go}
        // Middle-click closes, as it does on a browser tab.
        onAuxClick={close ? (e) => { if (e.button === 1) { e.preventDefault(); close(); } } : undefined}
        title={label}
      >
        {mark}
        <span className={c.name}>{label}</span>
      </button>
      {close && (
        <button type="button" className={c.close} onClick={close} aria-label={`Close ${label}`} title="Close tab">
          ×
        </button>
      )}
    </div>
  );

  const fixed = [
    item('home', 'All boards', HOME_ICON, !plannerOpen && !activeTabId, () => setActiveTab(null)),
    item('calendar', 'Calendar', CALENDAR_ICON, plannerOpen, () => setPlannerOpen(true)),
  ];
  const boards = open.map((id) => {
    const tab = tabs[id];
    const dot = <span className="space-dot" style={{ background: projects[tab.projectId]?.color ?? 'var(--ink-mute)' }} />;
    return item(id, tab.name || 'Untitled', dot, !plannerOpen && activeTabId === id, () => setActiveTab(id), () => closeTab(id));
  });

  if (orientation === 'row') {
    return (
      <nav className="navtabs" aria-label="Tabs">
        {fixed}
        {boards.length > 0 && <span className="navtabs-divider" aria-hidden />}
        {boards}
      </nav>
    );
  }
  return (
    <nav className="sidebar-sec navtabs-col" aria-label="Tabs">
      <div className="space-list">{fixed}</div>
      <div>
        <div className="sidebar-sec-head"><span className="sidebar-sec-label">Open boards</span></div>
        {boards.length > 0 ? (
          <div className="space-list">{boards}</div>
        ) : (
          <p className="navtabs-empty">Boards you open stay here, one click away.</p>
        )}
      </div>
    </nav>
  );
}
