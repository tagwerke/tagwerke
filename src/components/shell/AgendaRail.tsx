// The persistent day agenda in the sidebar. Shows TODAY's events (meetings + 1:1s) on the
// events model, sorted by start. A board-linked row opens its board; a 1:1 opens the full
// calendar. The header and "+ event" both open the calendar. Refetches when the calendar
// closes so a just-created event shows here too.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { api, drain } from '../../api/client';
import { toISO, formatDateChip } from '../../util/dates';
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

export function AgendaRail() {
  const me = useSession((s) => s.user);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const plannerOpen = useStore((s) => s.plannerOpen);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const today = toISO(new Date());

  // Load on mount and whenever the calendar closes (a new event may have been added there).
  useEffect(() => {
    if (!me || plannerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        await drain();
        const { events } = await api.calendar.list(today, today);
        if (!cancelled) setEvents(events);
      } catch {
        // Offline / error: keep whatever is already shown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, today, plannerOpen]);

  const list = [...events].sort(order);

  return (
    <div className="agenda-rail">
      <button className="agenda-head" onClick={() => setPlannerOpen(true)} title="Open calendar">
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
            <button
              key={ev.id}
              className="agenda-item"
              onClick={() => (ev.tabId ? setActiveTab(ev.tabId) : setPlannerOpen(true))}
              style={project ? ({ '--accent': project.color } as React.CSSProperties) : undefined}
            >
              <span className="agenda-time">{hm(ev.start)}</span>
              <span className="agenda-body">
                <span className="agenda-name">{ev.title || tab?.name || '1:1'}</span>
                {tab && <span className="agenda-board">{project ? `${project.name} · ${tab.name}` : tab.name}</span>}
              </span>
            </button>
          );
        })}
        <button className="agenda-add" onClick={() => setPlannerOpen(true)}>
          + event
        </button>
      </div>
    </div>
  );
}
