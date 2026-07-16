// The full calendar surface (replaces the orphaned Planner). A day/week grid of events on
// the events model: project meetings (board-linked) + board-less 1:1s. Phase 2 is read-only
// — create/edit and drag/resize arrive in later phases. Reuses the planner* UI state
// (date cursor + day/week mode) so nav feels the same.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { api, drain, ApiError } from '../../api/client';
import { toISO } from '../../util/dates';
import { TimeGrid } from './TimeGrid';
import { EventEditor } from './EventEditor';
import { dayOf } from './geometry';
import type { CalendarEvent } from '../../types';

interface EditorTarget {
  day: string;
  event?: CalendarEvent;
  seedStartMin?: number;
}

function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + deltaDays);
  return toISO(d);
}

function startOfWeek(iso: string): Date {
  const d = new Date(iso + 'T00:00:00');
  const mondayOffset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - mondayOffset);
  return d;
}

function windowFor(date: string, mode: 'day' | 'week'): { from: string; to: string; days: string[] } {
  if (mode === 'day') return { from: date, to: date, days: [date] };
  const start = startOfWeek(date);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(toISO(d));
  }
  return { from: days[0], to: days[6], days };
}

export function CalendarView() {
  const me = useSession((s) => s.user);
  const eventsMap = useStore((s) => s.events);
  const setEvents = useStore((s) => s.setEvents);
  const plannerDate = useStore((s) => s.plannerDate);
  const plannerMode = useStore((s) => s.plannerMode);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const setPlannerDate = useStore((s) => s.setPlannerDate);
  const setPlannerMode = useStore((s) => s.setPlannerMode);

  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const today = toISO(new Date());
  const { from, to, days } = windowFor(plannerDate, plannerMode);

  // Load the window whenever it (or the user) changes. A cancel guard drops a stale
  // response if the date/mode moved on before the fetch resolved.
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    (async () => {
      try {
        await drain(); // let optimistic writes settle before re-reading
        const { events } = await api.calendar.list(from, to);
        if (cancelled) return;
        setEvents(events);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setError('offline — showing your saved events');
        } else {
          setError(e instanceof ApiError ? e.message : 'failed to load calendar');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, from, to, setEvents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlannerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPlannerOpen]);

  const events = useMemo(() => Object.values(eventsMap), [eventsMap]);
  const step = plannerMode === 'week' ? 7 : 1;

  return (
    <main className="calendar">
      <header className="calendar-head">
        <button className="back-btn" onClick={() => setPlannerOpen(false)} aria-label="back to board">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
          <span>board</span>
        </button>
        <div className="calendar-nav">
          <button className="icon-btn" onClick={() => setPlannerDate(shiftDate(plannerDate, -step))} aria-label="previous">‹</button>
          <button className="btn ghost" onClick={() => setPlannerDate(today)}>today</button>
          <button className="icon-btn" onClick={() => setPlannerDate(shiftDate(plannerDate, step))} aria-label="next">›</button>
          <input type="date" className="calendar-date-input" value={plannerDate} onChange={(e) => e.target.value && setPlannerDate(e.target.value)} />
        </div>
        <div className="calendar-modes">
          <button className={`btn ghost ${plannerMode === 'day' ? 'is-active' : ''}`} onClick={() => setPlannerMode('day')}>day</button>
          <button className={`btn ghost ${plannerMode === 'week' ? 'is-active' : ''}`} onClick={() => setPlannerMode('week')}>week</button>
        </div>
      </header>

      {error && <div className="calendar-error">{error}</div>}

      <TimeGrid
        days={days}
        events={events}
        today={today}
        onCreateAt={(day, seedStartMin) => setEditor({ day, seedStartMin })}
        onEditEvent={(event) => setEditor({ day: event.start ? dayOf(event.start) : today, event })}
      />

      {editor && (
        <EventEditor day={editor.day} event={editor.event} seedStartMin={editor.seedStartMin} onClose={() => setEditor(null)} />
      )}
    </main>
  );
}
