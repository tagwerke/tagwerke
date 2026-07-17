// One event positioned on the grid. Interactions (hand-rolled, no library):
//   - click            → open the editor
//   - drag body        → reschedule (duration preserved)
//   - drag top/bottom  → resize start/end
//   - ↑/↓              → nudge 15 min; Shift+↑/↓ resize end; Delete → remove
// Moves/resizes snap to 15 min, are clamped to the day and a 15-min floor, commit
// optimistically via updateEvent, and show a live HH:MM–HH:MM tooltip while dragging.

import { useRef, useState } from 'react';
import { useStore } from '../../store';
import { minsOfClock, fmtMin, dayOf, PX_PER_MIN, MIN_EVENT_MIN, DAY_MINUTES, type LaidOut } from './geometry';
import type { CalendarEvent } from '../../types';

const SNAP = 15;
const snap = (min: number) => Math.round(min / SNAP) * SNAP;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

type Mode = 'move' | 'resize-top' | 'resize-bottom';
type Column = { day: string; rect: DOMRect };
interface Drag {
  mode: Mode;
  startClientY: number;
  origStart: number;
  origEnd: number;
  lastCol?: Column; // most recent column the pointer was over (for off-grid tolerance)
}
/** Viewport-space box for the floating ghost while dragging across day columns. */
interface Fixed {
  left: number;
  top: number;
  width: number;
  height: number;
}

function weekdayOf(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
}

export function EventCard({
  event,
  box,
  onClick,
  columnAt,
}: {
  event: CalendarEvent;
  box: LaidOut;
  onClick: () => void;
  /** week view only: map a pointer x to its day column (+ rect), enabling cross-day drag */
  columnAt?: (x: number) => { day: string; rect: DOMRect } | null;
}) {
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const updateEvent = useStore((s) => s.updateEvent);
  const deleteEvent = useStore((s) => s.deleteEvent);

  const dragRef = useRef<Drag | null>(null);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [preview, setPreview] = useState<{ s: number; e: number; day: string; fixed?: Fixed } | null>(null);

  const tab = event.tabId ? tabs[event.tabId] : undefined;
  const project = tab ? projects[tab.projectId] : undefined;
  const personal = !event.tabId;
  const day = event.start ? dayOf(event.start) : '';

  const startMin = event.start ? minsOfClock(event.start) : 0;
  const endMin = event.end ? minsOfClock(event.end) : startMin + MIN_EVENT_MIN;

  // Resolve a drag delta into new [start, end] under the active mode + constraints.
  const resolve = (mode: Mode, deltaMin: number): { s: number; e: number } => {
    const dur = dragRef.current!.origEnd - dragRef.current!.origStart;
    const os = dragRef.current!.origStart;
    const oe = dragRef.current!.origEnd;
    if (mode === 'move') {
      const s = clamp(snap(os + deltaMin), 0, DAY_MINUTES - dur);
      return { s, e: s + dur };
    }
    if (mode === 'resize-top') {
      const s = clamp(snap(os + deltaMin), 0, oe - MIN_EVENT_MIN);
      return { s, e: oe };
    }
    const e = clamp(snap(oe + deltaMin), os + MIN_EVENT_MIN, DAY_MINUTES);
    return { s: os, e };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!event.start || !event.end) return; // untimed events aren't draggable
    const mode = ((e.target as HTMLElement).dataset.handle as Mode) || 'move';
    dragRef.current = { mode, startClientY: e.clientY, origStart: startMin, origEnd: endMin, lastCol: columnAt?.(e.clientX) ?? undefined };
    movedRef.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaMin = (e.clientY - d.startClientY) / PX_PER_MIN;
    if (Math.abs(e.clientY - d.startClientY) > 3) movedRef.current = true;
    const { s, e: end } = resolve(d.mode, deltaMin);
    // A body-move in week view floats as a ghost that snaps to the column under the
    // pointer (edge-resize and day view stay anchored in place).
    if (d.mode === 'move' && columnAt) {
      const col = columnAt(e.clientX) ?? d.lastCol;
      if (col) d.lastCol = col;
      const fixed: Fixed | undefined = col
        ? { left: col.rect.left + 2, width: col.rect.width - 4, top: col.rect.top + s * PX_PER_MIN, height: (end - s) * PX_PER_MIN }
        : undefined;
      setPreview({ s, e: end, day: col?.day ?? day, fixed });
    } else {
      setPreview({ s, e: end, day });
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && movedRef.current && preview) {
      suppressClickRef.current = true; // swallow the click that follows a drag
      updateEvent(event.id, { start: `${preview.day}T${hm(preview.s)}`, end: `${preview.day}T${hm(preview.e)}` });
    }
    setPreview(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!event.start || !event.end) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteEvent(event.id);
      return;
    }
    const dir = e.key === 'ArrowUp' ? -SNAP : e.key === 'ArrowDown' ? SNAP : 0;
    if (!dir) return;
    e.preventDefault();
    if (e.shiftKey) {
      const en = clamp(endMin + dir, startMin + MIN_EVENT_MIN, DAY_MINUTES);
      updateEvent(event.id, { end: `${day}T${hm(en)}` });
    } else {
      const dur = endMin - startMin;
      const s = clamp(startMin + dir, 0, DAY_MINUTES - dur);
      updateEvent(event.id, { start: `${day}T${hm(s)}`, end: `${day}T${hm(s + dur)}` });
    }
  };

  const ghost = preview?.fixed;
  const topPx = preview ? preview.s * PX_PER_MIN : box.topPx;
  const heightPx = preview ? (preview.e - preview.s) * PX_PER_MIN : box.heightPx;
  const style: React.CSSProperties = ghost
    ? { position: 'fixed', left: `${ghost.left}px`, top: `${ghost.top}px`, width: `${ghost.width}px`, height: `${ghost.height}px` }
    : { top: `${topPx}px`, height: `${heightPx}px`, left: `calc(${box.leftPct}% + 2px)`, width: `calc(${box.widthPct}% - 4px)` };
  if (project) (style as Record<string, string>)['--accent'] = project.color;
  const timeLabel = preview
    ? `${fmtMin(preview.s)}–${fmtMin(preview.e)}`
    : event.start
      ? `${fmtMin(startMin)}${event.end ? `–${fmtMin(endMin)}` : ''}`
      : '';

  return (
    <button
      className={`cal-event ${personal ? 'is-personal' : 'is-meeting'} ${preview ? 'is-dragging' : ''} ${ghost ? 'is-ghost' : ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        e.stopPropagation();
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        onClick();
      }}
      title={event.title ?? tab?.name ?? '1:1'}
    >
      <span className="cal-event-resize top" data-handle="resize-top" aria-hidden />
      {preview && (
        <span className="cal-event-tip">
          {preview.day !== day && `${weekdayOf(preview.day)} `}{fmtMin(preview.s)}–{fmtMin(preview.e)}
        </span>
      )}
      <span className="cal-event-time">{timeLabel}</span>
      <span className="cal-event-title">{event.title || tab?.name || '1:1'}</span>
      {tab && <span className="cal-event-board">{project ? `${project.name} · ${tab.name}` : tab.name}</span>}
      <span className="cal-event-resize bottom" data-handle="resize-bottom" aria-hidden />
    </button>
  );
}
