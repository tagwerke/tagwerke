// The persistent day agenda in the sidebar — and the quick-manage surface for today's
// events. Reads the store (so edits show instantly) and refetches today's events when the
// calendar is closed. Click a row to edit/retime/delete, "+ event" to create with a time —
// all inline via the same EventEditor, without leaving the board. The header opens the full
// calendar grid.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { api, drain } from '../../api/client';
import { toISO, formatDateChip } from '../../util/dates';
import { EventEditor } from '../calendar/EventEditor';
import { dayOf } from '../calendar/geometry';
import type { CalendarEvent } from '../../types';

/** Sort: timed events first (by start), untimed last. */
function order(a: CalendarEvent, b: CalendarEvent): number {
  const as = a.start ?? '99:99';
  const bs = b.start ?? '99:99';
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function hm(iso: string | null | undefined): string {
  const m = iso ? /T(\d{2}):(\d{2})/.exec(iso) : null;
  return m ? `${m[1]}:${m[2]}` : '—';
}

/** A sensible default start for a quick add: now, rounded up to the next 30 min. */
function seedNow(): number {
  const d = new Date();
  const min = Math.ceil((d.getHours() * 60 + d.getMinutes()) / 30) * 30;
  return Math.min(min, 22 * 60);
}

type Editor = { event?: CalendarEvent; seedStartMin?: number } | null;

export function AgendaRail() {
  const me = useSession((s) => s.user);
  const eventsMap = useStore((s) => s.events);
  const setEvents = useStore((s) => s.setEvents);
  const deleteEvent = useStore((s) => s.deleteEvent);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);

  const [editor, setEditor] = useState<Editor>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const today = toISO(new Date());

  // Populate today's events from the server when the calendar isn't the one driving the
  // store. Runs on mount, when the calendar closes, and after an inline edit closes.
  useEffect(() => {
    if (!me || plannerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        await drain();
        const { events } = await api.calendar.list(today, today);
        if (!cancelled) setEvents(events);
      } catch {
        // Offline / error: keep whatever is already in the store.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, today, plannerOpen, reloadKey, setEvents]);

  const list = useMemo(
    () => Object.values(eventsMap).filter((e) => (e.start ? dayOf(e.start) === today : false)).sort(order),
    [eventsMap, today],
  );

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
      <div className="agenda-list">
        {list.length === 0 && <p className="agenda-empty muted">Nothing scheduled.</p>}
        {list.map((ev) => {
          const tab = ev.tabId ? tabs[ev.tabId] : undefined;
          const project = tab ? projects[tab.projectId] : undefined;
          return (
            <div
              key={ev.id}
              className="agenda-item"
              role="button"
              tabIndex={0}
              onClick={() => setEditor({ event: ev })}
              onKeyDown={(e) => e.key === 'Enter' && setEditor({ event: ev })}
              style={project ? ({ '--accent': project.color } as React.CSSProperties) : undefined}
            >
              <span className="agenda-time">{hm(ev.start)}</span>
              <span className="agenda-body">
                <span className="agenda-name">{ev.title || tab?.name || '1:1'}</span>
                {tab && <span className="agenda-board">{project ? `${project.name} · ${tab.name}` : tab.name}</span>}
              </span>
              <button
                className="icon-btn delete agenda-del"
                title="delete event"
                aria-label="delete event"
                onClick={(e) => { e.stopPropagation(); deleteEvent(ev.id); }}
              >
                <svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </div>
          );
        })}
        <button className="agenda-add" onClick={() => setEditor({ seedStartMin: seedNow() })}>
          + event
        </button>
      </div>

      {editor && (
        <EventEditor day={today} event={editor.event} seedStartMin={editor.seedStartMin} onClose={closeEditor} />
      )}
    </div>
  );
}
