// The tabs: what you are working on, and one click to switch. Two fixed tabs (All boards, Calendar),
// then every board you have opened, in the order you opened it, each closable like a browser tab.
// Drawn as a column in the sidebar or a strip in the top bar; the layout setting picks which, and the
// header takes the other bar (useShell).
//
// The column reuses the sidebar's row classes; the strip has its own.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
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

// The strip sticks to the top of the window and slides away while you scroll down, back in the
// moment you scroll up (or reach the top): a long board never costs a trip to the top for the tabs.
function useHideOnScrollDown(enabled: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled) { setHidden(false); return; }
    let last = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        const dy = y - last;
        if (y < 80) setHidden(false);
        else if (dy > 6) setHidden(true);
        else if (dy < -6) setHidden(false);
        if (Math.abs(dy) > 6 || y < 80) last = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [enabled]);
  return hidden;
}

type Drop = { id: string; place: 'before' | 'after' };

// Reordering with pointer events, not the browser's drag-and-drop: native DnD won't start from a
// <button> in Firefox and gives no say over the drag image. A press that moves more than a few pixels
// becomes a drag (a plain click still switches tabs); the tab under the pointer along the bar's axis
// is the drop target; Escape cancels. Mouse and pen only: on touch the strip scrolls.
function useTabDrag(orientation: Orientation, moveTab: (id: string, target: string, place: 'before' | 'after') => void) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const justDragged = useRef(false);

  const begin = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    const x0 = e.clientX, y0 = e.clientY;
    let active = false;
    let target: Drop | null = null;

    const find = (x: number, y: number): Drop | null => {
      const els = Array.from(navRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []);
      let best: Drop | null = null, bestDist = Infinity;
      for (const el of els) {
        const tid = el.dataset.tabId!;
        if (tid === id) continue;
        const r = el.getBoundingClientRect();
        const mid = orientation === 'row' ? r.left + r.width / 2 : r.top + r.height / 2;
        const p = orientation === 'row' ? x : y;
        if (Math.abs(p - mid) < bestDist) { bestDist = Math.abs(p - mid); best = { id: tid, place: p < mid ? 'before' : 'after' }; }
      }
      return best;
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      document.body.classList.remove('is-tab-dragging');
      if (active) {
        if (commit && target) moveTab(id, target.id, target.place);
        // The click that follows this release must not also switch tabs.
        justDragged.current = true;
        setTimeout(() => { justDragged.current = false; }, 0);
      }
      setDragId(null);
      setDrop(null);
    };
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        active = true;
        document.body.classList.add('is-tab-dragging');
        setDragId(id);
      }
      target = find(ev.clientX, ev.clientY);
      setDrop(target);
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
  };

  return { navRef, dragId, drop, begin, justDragged };
}

export function NavTabs({ orientation }: { orientation: Orientation }) {
  const hidden = useHideOnScrollDown(orientation === 'row');
  const openIds = useShell((s) => s.openIds);
  const closeTab = useShell((s) => s.closeTab);
  const moveTab = useShell((s) => s.moveTab);
  const { navRef, dragId, drop, begin, justDragged } = useTabDrag(orientation, moveTab);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const activeTabId = useStore((s) => s.activeTabId);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const c = CLASSES[orientation];
  const open = openIds.filter((id) => tabs[id]);

  const item = (key: string, label: string, mark: ReactNode, on: boolean, go: () => void, close?: () => void) => (
    <div
      key={key}
      className={`${c.item} ${on ? 'on' : ''} ${close ? '' : 'is-fixed'} ${dragId === key ? 'is-dragging' : ''}`}
      // Only board tabs (the ones that can close) are movable; the two fixed tabs stay put.
      data-tab-id={close ? key : undefined}
      data-drop={close && drop?.id === key ? drop.place : undefined}
      onPointerDown={close ? (e) => begin(e, key) : undefined}
    >
      <button
        type="button"
        className={c.main}
        aria-current={on ? 'page' : undefined}
        onClick={(e) => { if (justDragged.current) { e.preventDefault(); return; } go(); }}
        // Middle-click closes, as it does on a browser tab.
        onAuxClick={close ? (e) => { if (e.button === 1) { e.preventDefault(); close(); } } : undefined}
        title={label}
      >
        {mark}
        <span className={c.name}>{label}</span>
      </button>
      {close && (
        <button type="button" className={c.close} data-no-drag onClick={close} aria-label={`Close ${label}`} title="Close tab">
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
      <nav ref={navRef} className={`navtabs ${hidden ? 'is-hidden' : ''}`} aria-label="Tabs">
        {fixed}
        {boards.length > 0 && <span className="navtabs-divider" aria-hidden />}
        {boards}
      </nav>
    );
  }
  return (
    <nav ref={navRef} className="sidebar-sec navtabs-col" aria-label="Tabs">
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
