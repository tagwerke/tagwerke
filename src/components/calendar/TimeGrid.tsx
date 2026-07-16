// The scrollable hour grid: a left time-ruler + one column per day. Each column stacks its
// timed events (absolutely positioned by clock time, overlaps split into lanes) with an
// all-day lane above and, on the current day, a live "now" line. Read-only in phase 2 —
// the pointer/drag interaction layer is added later.
//
// Layout: the header row, all-day row, and grid body all share one grid template
// (gutter + one 1fr per day) so day columns line up top-to-bottom.

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDateChip } from '../../util/dates';
import { EventCard } from './EventCard';
import { HOUR_PX, DAY_MINUTES, PX_PER_MIN, dayOf, minsOfClock, layoutDay } from './geometry';
import type { CalendarEvent } from '../../types';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const SCROLL_TO_MIN = 7 * 60; // open the day around 07:00
const SNAP_MIN = 15;

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timedOn(events: CalendarEvent[], day: string): CalendarEvent[] {
  return events.filter((e) => e.start && e.end && !e.allDay && dayOf(e.start) === day);
}

function allDayOn(events: CalendarEvent[], day: string): CalendarEvent[] {
  return events.filter((e) => (e.allDay || !e.start) && !!e.occurrences?.some((o) => o.date === day));
}

export function TimeGrid({
  days,
  events,
  today,
  onCreateAt,
  onEditEvent,
}: {
  days: string[];
  events: CalendarEvent[];
  today: string;
  onCreateAt: (day: string, startMin: number) => void;
  onEditEvent: (event: CalendarEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef(new Map<string, HTMLElement>());
  const isWeek = days.length > 1;
  const template = { '--cal-days': days.length } as React.CSSProperties;

  // Which day column sits under an x coordinate — for cross-day drag (week view only).
  const dayAtClientX = (x: number): string | null => {
    for (const [day, el] of colRefs.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x < r.right) return day;
    }
    return null;
  };

  // Auto-scroll to the earliest timed event, or 07:00 — whichever is higher up.
  const firstMin = useMemo(() => {
    let m = Infinity;
    for (const d of days) for (const e of timedOn(events, d)) m = Math.min(m, minsOfClock(e.start!));
    return Number.isFinite(m) ? m : SCROLL_TO_MIN;
  }, [days, events]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, Math.min(firstMin, SCROLL_TO_MIN) * PX_PER_MIN - HOUR_PX / 2);
  }, [firstMin]);

  const [now, setNow] = useState(nowMinutes());
  useEffect(() => {
    const id = setInterval(() => setNow(nowMinutes()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="cal-grid" style={template}>
      {isWeek && (
        <div className="cal-row cal-heads">
          <div className="cal-gutter" />
          {days.map((day) => (
            <div className={`cal-head ${day === today ? 'is-today' : ''}`} key={day}>
              {formatDateChip(day)}
            </div>
          ))}
        </div>
      )}

      <div className="cal-row cal-allday">
        <div className="cal-gutter cal-allday-label">all-day</div>
        {days.map((day) => (
          <div className="cal-allday-cell" key={day}>
            {allDayOn(events, day).map((e) => (
              <span className="cal-allday-chip" key={e.id} title={e.title ?? '1:1'}>{e.title || '1:1'}</span>
            ))}
          </div>
        ))}
      </div>

      <div className="cal-scroll" ref={scrollRef}>
        <div className="cal-body cal-row" style={{ height: `${DAY_MINUTES * PX_PER_MIN}px` }}>
          <div className="cal-gutter cal-ruler">
            {HOURS.map((h) => (
              <div className="cal-hour-label" key={h} style={{ top: `${h * HOUR_PX}px` }}>
                {String(h).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {days.map((day) => {
            const timed = timedOn(events, day);
            const boxById = new Map(layoutDay(timed.map((e) => ({ id: e.id, start: e.start!, end: e.end! }))).map((b) => [b.id, b]));
            return (
              <div
                className={`cal-col ${day === today ? 'is-today' : ''}`}
                key={day}
                ref={(el) => { if (el) colRefs.current.set(day, el); else colRefs.current.delete(day); }}
                onClick={(e) => {
                  // Click on empty grid → create at the snapped minute. Clicks on event
                  // cards stopPropagation, so this only fires on the column background.
                  const minute = Math.max(0, Math.min(DAY_MINUTES - SNAP_MIN, Math.round(e.nativeEvent.offsetY / PX_PER_MIN / SNAP_MIN) * SNAP_MIN));
                  onCreateAt(day, minute);
                }}
              >
                {HOURS.map((h) => (
                  <div className="cal-hour-line" key={h} style={{ top: `${h * HOUR_PX}px` }} />
                ))}
                {timed.map((e) => {
                  const box = boxById.get(e.id);
                  return box ? (
                    <EventCard key={e.id} event={e} box={box} onClick={() => onEditEvent(e)} dayAtClientX={isWeek ? dayAtClientX : undefined} />
                  ) : null;
                })}
                {day === today && (
                  <div className="cal-now" style={{ top: `${now * PX_PER_MIN}px` }}>
                    <span className="cal-now-dot" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
