// One event positioned on the grid. Shows time + title; clicking opens the editor. Project
// meetings take their board's project accent; board-less 1:1s render in a neutral
// "personal" style. Drag/resize arrive in a later phase.

import { useStore } from '../../store';
import { minsOfClock, fmtMin, type LaidOut } from './geometry';
import type { CalendarEvent } from '../../types';

export function EventCard({ event, box, onClick }: { event: CalendarEvent; box: LaidOut; onClick: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);

  const tab = event.tabId ? tabs[event.tabId] : undefined;
  const project = tab ? projects[tab.projectId] : undefined;
  const personal = !event.tabId;

  const timeLabel = event.start
    ? `${fmtMin(minsOfClock(event.start))}${event.end ? `–${fmtMin(minsOfClock(event.end))}` : ''}`
    : '';

  return (
    <button
      className={`cal-event ${personal ? 'is-personal' : 'is-meeting'}`}
      style={{
        top: `${box.topPx}px`,
        height: `${box.heightPx}px`,
        left: `calc(${box.leftPct}% + 2px)`,
        width: `calc(${box.widthPct}% - 4px)`,
        ...(project ? ({ '--accent': project.color } as React.CSSProperties) : {}),
      }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={event.title ?? tab?.name ?? '1:1'}
    >
      <span className="cal-event-time">{timeLabel}</span>
      <span className="cal-event-title">{event.title || tab?.name || '1:1'}</span>
      {tab && <span className="cal-event-board">{project ? `${project.name} · ${tab.name}` : tab.name}</span>}
    </button>
  );
}
