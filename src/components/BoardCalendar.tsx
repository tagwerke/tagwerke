// Calendar view: a month grid placing this board's tasks (by `date`) and events (by their
// server-expanded occurrence dates) together. No new data — reuses the events API + tasks.

import { useEffect, useMemo, useState } from 'react';
import { useTasksForTab } from '../store';
import { api, type BoardEvent } from '../api/client';
import { toISO } from '../util/dates';
import type { Task } from '../types';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 42 ISO day strings (6 weeks, Monday-first) covering the month of `cursorISO` (YYYY-MM-01). */
function monthDays(cursorISO: string): string[] {
  const first = new Date(cursorISO + 'T00:00:00');
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(first);
  start.setDate(1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return toISO(d);
  });
}

function shiftMonth(cursorISO: string, delta: number): string {
  const d = new Date(cursorISO + 'T00:00:00');
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function firstOfThisMonth(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`;
}

export function BoardCalendar({ tabId }: { tabId: string }) {
  const tasks = useTasksForTab(tabId);
  const [cursor, setCursor] = useState(firstOfThisMonth);
  const [events, setEvents] = useState<BoardEvent[]>([]);

  useEffect(() => {
    let alive = true;
    api.events
      .list(tabId)
      .then((r) => { if (alive) setEvents(r.events); })
      .catch(() => { /* best-effort */ });
    return () => { alive = false; };
  }, [tabId]);

  const days = useMemo(() => monthDays(cursor), [cursor]);
  const monthKey = cursor.slice(0, 7);
  const today = toISO(new Date());

  const tasksByDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) if (t.date) (m.get(t.date) ?? m.set(t.date, []).get(t.date)!).push(t);
    return m;
  }, [tasks]);

  const eventsByDay = useMemo(() => {
    const m = new Map<string, { time: string }[]>();
    for (const ev of events) {
      const time = ev.start ? new Date(ev.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
      for (const occ of ev.occurrences) (m.get(occ.date) ?? m.set(occ.date, []).get(occ.date)!).push({ time });
    }
    return m;
  }, [events]);

  const monthLabel = new Date(cursor + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="board-calendar">
      <div className="cal-head">
        <button className="icon-btn" onClick={() => setCursor((c) => shiftMonth(c, -1))} aria-label="previous month">‹</button>
        <button className="btn ghost" onClick={() => setCursor(firstOfThisMonth())}>today</button>
        <button className="icon-btn" onClick={() => setCursor((c) => shiftMonth(c, 1))} aria-label="next month">›</button>
        <span className="cal-month">{monthLabel}</span>
      </div>
      <div className="cal-grid">
        {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {days.map((day) => {
          const inMonth = day.slice(0, 7) === monthKey;
          const dayTasks = tasksByDay.get(day) ?? [];
          const dayEvents = eventsByDay.get(day) ?? [];
          return (
            <div key={day} className={`cal-cell ${inMonth ? '' : 'is-out'} ${day === today ? 'is-today' : ''}`}>
              <span className="cal-dn">{Number(day.slice(8))}</span>
              {dayEvents.slice(0, 2).map((e, i) => (
                <div key={`e${i}`} className="cal-ev meet" title="event">{e.time || 'event'}</div>
              ))}
              {dayTasks.slice(0, 3).map((t) => (
                <div key={t.id} className="cal-ev task" title={t.text}>{t.text || '(empty)'}</div>
              ))}
              {dayTasks.length + dayEvents.length > 5 && (
                <div className="cal-more">+{dayTasks.length + dayEvents.length - 5}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
