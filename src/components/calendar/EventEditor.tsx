// Create / edit an event. Opened by clicking empty grid (create, seeded with the clicked
// time) or an existing event (edit). Board is OPTIONAL: blank = a 1:1 / board-less meeting,
// set = a project meeting. Times are local wall-clock composed into ISO with the event's day
// (single-timezone instance). Reuses the app's .modal pattern.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { rankTabs } from '../../util/header';
import { Dropdown, type DropdownOption } from '../Dropdown';
import { STATUS_ORDER, STATUS_LABEL } from '../StatusControl';
import { AgendaList } from './AgendaList';
import { dayOf } from './geometry';
import type { BlockFilter, CalendarEvent, RsvpStatus, TaskStatus } from '../../types';

const NO_BOARD = '__none__';

const RSVP_LABEL: Record<Exclude<RsvpStatus, 'needs-action'>, string> = { accepted: 'Going', tentative: 'Maybe', declined: "Can't" };
const RSVP_ORDER: Exclude<RsvpStatus, 'needs-action'>[] = ['accepted', 'tentative', 'declined'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function hmOf(iso: string | null | undefined): string {
  const m = iso ? /T(\d{2}):(\d{2})/.exec(iso) : null;
  return m ? `${m[1]}:${m[2]}` : '';
}
function hmFromMin(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function EventEditor({
  day,
  event,
  seedStartMin,
  onClose,
}: {
  day: string;
  event?: CalendarEvent;
  seedStartMin?: number;
  onClose: () => void;
}) {
  const me = useSession((s) => s.user);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const tabOrder = useStore((s) => s.tabOrder);
  const createEvent = useStore((s) => s.createEvent);
  const updateEvent = useStore((s) => s.updateEvent);
  const deleteEvent = useStore((s) => s.deleteEvent);
  const rsvpEvent = useStore((s) => s.rsvpEvent);
  const setActiveTab = useStore((s) => s.setActiveTab);

  const editing = !!event;
  const eventDay = event?.start ? dayOf(event.start) : day;

  const [title, setTitle] = useState(event?.title ?? '');
  const [start, setStart] = useState(() => hmOf(event?.start) || hmFromMin(seedStartMin ?? 9 * 60));
  const [end, setEnd] = useState(() => hmOf(event?.end) || hmFromMin((seedStartMin ?? 9 * 60) + 30));
  const [tabId, setTabId] = useState<string>(event?.tabId ?? NO_BOARD);
  const [filter, setFilter] = useState<BlockFilter | null>(event?.filter ?? null);

  const hasBoard = tabId !== NO_BOARD;
  const myRsvp: RsvpStatus =
    event?.occurrences?.find((o) => o.date === eventDay)?.attendance.find((a) => a.userId === me?.id)?.status ?? 'needs-action';

  const toggleStatus = (s: TaskStatus) => {
    const cur = filter?.statuses ?? [];
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    setFilter({ ...filter, statuses: next.length ? next : undefined });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const boardOptions: DropdownOption[] = useMemo(
    () => [
      { value: NO_BOARD, label: 'No board · 1:1' },
      ...rankTabs('', tabs, projects, tabOrder).map((m) => ({
        value: m.tabId,
        label: m.projectName ? `${m.projectName} · ${m.name}` : m.name,
        accent: m.projectColor,
      })),
    ],
    [tabs, projects, tabOrder],
  );

  const save = () => {
    const s = start || '00:00';
    const e = end && end > s ? end : s; // never let end precede start
    const startISO = `${eventDay}T${s}`;
    const endISO = `${eventDay}T${e}`;
    const board = tabId === NO_BOARD ? null : tabId;
    const agendaFilter = board ? filter : null; // filter only meaningful with a board
    if (editing) {
      updateEvent(event.id, { tabId: board, title: title.trim() || null, start: startISO, end: endISO, filter: agendaFilter });
    } else {
      createEvent({ tabId: board, title: title.trim() || null, start: startISO, end: endISO, filter: agendaFilter, createdBy: me?.id ?? null });
    }
    onClose();
  };

  const remove = () => {
    if (event) deleteEvent(event.id);
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal cal-editor" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{editing ? 'edit event' : 'new event'}</h2>

        <label className="field">
          <span>title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="e.g. Design review, or 1:1 with Sam"
          />
        </label>

        <div className="cal-editor-times">
          <label className="field">
            <span>start</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>end</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>board</span>
          <Dropdown value={tabId} onChange={setTabId} options={boardOptions} placeholder="No board · 1:1" />
        </label>

        {editing && (
          <div className="field cal-rsvp">
            <span>going?</span>
            <div className="occ-rsvp">
              {RSVP_ORDER.map((st) => (
                <button
                  key={st}
                  className={`rsvp-btn ${myRsvp === st ? 'on' : ''}`}
                  onClick={() => me && rsvpEvent(event.id, eventDay, me.id, st)}
                >
                  {RSVP_LABEL[st]}
                </button>
              ))}
            </div>
          </div>
        )}

        {hasBoard && (
          <div className="field cal-agenda-field">
            <div className="cal-agenda-head">
              <span>agenda · live tasks</span>
              <div className="cal-agenda-filter">
                {STATUS_ORDER.map((s) => (
                  <button
                    key={s}
                    className={`status-chip status-${s} ${(filter?.statuses ?? []).includes(s) ? 'on' : ''}`}
                    onClick={() => toggleStatus(s)}
                    title={`filter: ${STATUS_LABEL[s]}`}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            <AgendaList tabId={tabId} filter={filter} />
          </div>
        )}

        {editing && event.tabId && (
          <button className="link-btn" onClick={() => { setActiveTab(event.tabId!); onClose(); }}>
            open board →
          </button>
        )}

        <div className="modal-actions">
          {editing ? (
            <button className="btn ghost cal-editor-delete" onClick={remove}>delete</button>
          ) : (
            <span />
          )}
          <div className="cal-editor-right">
            <button className="btn ghost" onClick={onClose}>cancel</button>
            <button className="btn primary" onClick={save}>{editing ? 'save' : 'create'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
