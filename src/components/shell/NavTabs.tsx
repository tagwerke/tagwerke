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

// A live drag: the tab follows the pointer (dx, px along the bar's axis), the tabs between its old
// and new slot slide out of the way by `size`, and `to` is the slot it would land in.
type Drag = { id: string; ids: string[]; from: number; to: number; dx: number; size: number; settling: boolean };

// Reordering like a browser's tab strip, with pointer events rather than the browser's drag-and-drop
// (native DnD won't start from a <button> in Firefox and gives no say over how the drag looks).
// Positions are measured once, at press. A press that moves a few pixels lifts the tab: it tracks the
// pointer along the bar, clamped to the row of tabs; the others shift a slot as it passes their
// centres. On release the tab glides into its slot and only then is the order committed, so the
// list never jumps. Escape glides it back. Mouse and pen only: on touch the strip scrolls.
const SETTLE_MS = 150;

function useTabDrag(orientation: Orientation, moveTab: (id: string, target: string, place: 'before' | 'after') => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const justDragged = useRef(false);
  const busy = useRef(false); // a release is still gliding in

  const begin = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0 || e.pointerType === 'touch' || busy.current) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    const els = Array.from(navRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []);
    const ids = els.map((el) => el.dataset.tabId!);
    const from = ids.indexOf(id);
    if (from < 0) return;

    const row = orientation === 'row';
    const rects = els.map((el) => el.getBoundingClientRect());
    const start = (r: DOMRect) => (row ? r.left : r.top);
    const len = (r: DOMRect) => (row ? r.width : r.height);
    const mine = rects[from];
    const gap = rects.length > 1 ? Math.max(0, start(rects[1]) - start(rects[0]) - len(rects[0])) : 0;
    const size = len(mine) + gap;
    const lo = start(rects[0]) - start(mine);
    const hi = start(rects[rects.length - 1]) + len(rects[rects.length - 1]) - start(mine) - len(mine);
    const p0 = row ? e.clientX : e.clientY;
    let active = false;
    let cur: Drag = { id, ids, from, to: from, dx: 0, size, settling: false };

    const slotStart = (to: number) =>
      to > from ? start(rects[to]) + len(rects[to]) - len(mine) : to < from ? start(rects[to]) : start(mine);

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      document.body.classList.remove('is-tab-dragging');
    };
    const settle = (commit: boolean) => {
      stop();
      if (!active) return;
      // The click that follows this release must not also switch tabs.
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      const to = commit ? cur.to : from;
      busy.current = true;
      setDrag({ ...cur, to, dx: slotStart(to) - start(mine), settling: true });
      setTimeout(() => {
        busy.current = false;
        if (to !== from) moveTab(id, ids[to], to > from ? 'after' : 'before');
        setDrag(null);
      }, SETTLE_MS);
    };
    const move = (ev: PointerEvent) => {
      const delta = (row ? ev.clientX : ev.clientY) - p0;
      if (!active) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        active = true;
        document.body.classList.add('is-tab-dragging');
      }
      const dx = Math.min(hi, Math.max(lo, delta));
      // A neighbour gives way once the dragged tab's leading edge passes its midpoint — like Chrome's.
      const lead = start(mine) + dx;
      const trail = lead + len(mine);
      let to = 0;
      rects.forEach((r, j) => {
        if (j === from) return;
        const mid = start(r) + len(r) / 2;
        if (j < from ? mid < lead : mid < trail) to++;
      });
      cur = { ...cur, dx, to };
      setDrag(cur);
    };
    const up = () => settle(true);
    const cancel = () => settle(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') settle(false); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  };

  return { navRef, drag, begin, justDragged };
}

export function NavTabs({ orientation }: { orientation: Orientation }) {
  const hidden = useHideOnScrollDown(orientation === 'row');
  const openIds = useShell((s) => s.openIds);
  const closeTab = useShell((s) => s.closeTab);
  const moveTab = useShell((s) => s.moveTab);
  const { navRef, drag, begin, justDragged } = useTabDrag(orientation, moveTab);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const activeTabId = useStore((s) => s.activeTabId);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const c = CLASSES[orientation];
  const open = openIds.filter((id) => tabs[id]);

  // How far a board tab is moved off its natural place while another is being dragged: the dragged
  // one follows the pointer, the ones it has passed slide one slot toward where it came from.
  const offsetOf = (key: string): number | undefined => {
    if (!drag) return undefined;
    if (key === drag.id) return drag.dx;
    const i = drag.ids.indexOf(key);
    if (i < 0) return undefined;
    if (i > drag.from && i <= drag.to) return -drag.size;
    if (i < drag.from && i >= drag.to) return drag.size;
    return 0;
  };

  const item = (key: string, label: string, mark: ReactNode, on: boolean, go: () => void, close?: () => void) => {
    const off = close ? offsetOf(key) : undefined;
    const lifted = !!drag && drag.id === key;
    return (
    <div
      key={key}
      className={`${c.item} ${on ? 'on' : ''} ${close ? '' : 'is-fixed'} ${lifted ? 'is-lifted' : off !== undefined ? 'is-shifting' : ''} ${lifted && drag.settling ? 'is-settling' : ''}`}
      // Only board tabs (the ones that can close) are movable; the two fixed tabs stay put.
      data-tab-id={close ? key : undefined}
      style={off !== undefined ? { transform: orientation === 'row' ? `translateX(${off}px)` : `translateY(${off}px)` } : undefined}
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
  };

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
