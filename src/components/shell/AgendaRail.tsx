// The sidebar day agenda — a compact TIMELINE (matches internal/design/shell-d-hybrid.html):
// hour labels in the left gutter, events positioned by clock time (overlaps split into
// lanes), and a live "now" line. Also the quick-manage surface: click an event to
// edit/retime/delete, "+ event" to create with a time — inline, without leaving the board.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { api, drain } from '../../api/client';
import { toISO, formatDateChip } from '../../util/dates';
import { EventEditor } from '../calendar/EventEditor';
import { minsOfClock, dayOf, layoutDay } from '../calendar/geometry';
import type { CalendarEvent } from '../../types';

const HOUR_PX = 50; // matches the mockup .hour height
const PX_PER_MIN = HOUR_PX / 60;

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function order(a: CalendarEvent, b: CalendarEvent): number {
  return (a.start ?? '') < (b.start ?? '') ? -1 : 1;
}

type Editor = { event?: CalendarEvent; seedStartMin?: number } | null;

export function AgendaRail() {
  const me = useSession((s) => s.user);
  const eventsMap = useStore((s) => s.events);
  const setEvents = useStore((s) => s.setEvents);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);

  const [editor, setEditor] = useState<Editor>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(nowMinutes());
  const today = toISO(new Date());

  // Populate today's events from the server when the calendar isn't driving the store.
  useEffect(() => {
    if (!me || plannerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        await drain();
        const { events } = await api.calendar.list(today, today);
        if (!cancelled) setEvents(events);
      } catch {
        /* offline: keep the store */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, today, plannerOpen, reloadKey, setEvents]);

  // Tick the now-line each minute.
  useEffect(() => {
    const id = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(
    () => Object.values(eventsMap).filter((e) => e.start && dayOf(e.start) === today).sort(order),
    [eventsMap, today],
  );

  // Hour window: bracket the events + now, at least a 5-hour span, clamped to the day.
  const { startH, hours } = useMemo(() => {
    const mins = list.flatMap((e) => [minsOfClock(e.start!), minsOfClock(e.end ?? e.start!)]);
    let lo = Math.floor(Math.min(now, ...mins) / 60);
    let hi = Math.ceil(Math.max(now + 60, ...mins) / 60);
    if (hi - lo < 5) hi = lo + 5;
    lo = Math.max(0, lo);
    hi = Math.min(24, hi);
    if (hi - lo < 5) lo = Math.max(0, hi - 5);
    return { startH: lo, hours: Array.from({ length: hi - lo }, (_, i) => lo + i) };
  }, [list, now]);

  // Overlap lanes (reuse the grid's column layout; take only left/width).
  const lanes = useMemo(() => {
    const boxes = layoutDay(list.map((e) => ({ id: e.id, start: e.start!, end: e.end ?? e.start! })));
    return new Map(boxes.map((b) => [b.id, b]));
  }, [list]);

  const top = (iso: string) => (minsOfClock(iso) - startH * 60) * PX_PER_MIN;
  const closeEditor = () => {
    setEditor(null);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="agenda-rail">
      <button className="agenda-head" onClick={() => setPlannerOpen(true)} title="Open full calendar">
        <span className="agenda-title">Today</span>
        <span className="agenda-date">{formatDateChip(today)}</span>
        <span className="agenda-open" aria-hidden>→</span>
      </button>
      <div className="agenda-sub">{list.length ? `${list.length} scheduled` : 'Nothing scheduled'}</div>

      <div className="agenda-timeline">
        {hours.map((h) => (
          <div className="agenda-hour" key={h} data-h={`${String(h).padStart(2, '0')}:00`} />
        ))}

        {list.map((ev) => {
          const tab = ev.tabId ? tabs[ev.tabId] : undefined;
          const project = tab ? projects[tab.projectId] : undefined;
          const lane = lanes.get(ev.id);
          const endMin = minsOfClock(ev.end ?? ev.start!);
          const height = Math.max(20, (endMin - minsOfClock(ev.start!)) * PX_PER_MIN);
          return (
            <button
              key={ev.id}
              className={`agenda-ev ${tab ? 'meet' : 'solo'}`}
              style={{
                top: `${top(ev.start!)}px`,
                height: `${height}px`,
                left: `calc(${lane?.leftPct ?? 0}% + 9px)`,
                width: `calc(${lane?.widthPct ?? 100}% - 11px)`,
                ...(project ? ({ '--accent': project.color } as React.CSSProperties) : {}),
              }}
              onClick={() => setEditor({ event: ev })}
              title={ev.title ?? tab?.name ?? '1:1'}
            >
              <span className="k">{hhmm(minsOfClock(ev.start!))}</span>
              <span className="nm2">{ev.title || tab?.name || '1:1'}</span>
              {tab && <span className="mt">{project ? `${project.name} · ${tab.name}` : tab.name}</span>}
            </button>
          );
        })}

        <div className="agenda-nowline" style={{ top: `${(now - startH * 60) * PX_PER_MIN}px` }}>
          <span className="lbl">now</span>
        </div>
      </div>

      <button className="agenda-add" onClick={() => setEditor({ seedStartMin: Math.min(Math.ceil(now / 30) * 30, 22 * 60) })}>
        + event
      </button>

      {editor && <EventEditor day={today} event={editor.event} seedStartMin={editor.seedStartMin} onClose={closeEditor} />}
    </div>
  );
}
