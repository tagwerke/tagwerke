// Board calendar facet UI: edit the board's location, add events (optionally recurring),
// and RSVP per occurrence. Reads expand recurring events server-side; this just renders
// occurrences and lets each member set their own going/maybe/not for each one.

import { useEffect, useState } from 'react';
import { api, ApiError, type AttendanceStatus, type BoardEvent } from '../api/client';
import { useStore } from '../store';
import { useSession } from '../session/useSession';

// Common recurrence presets → RRULE. Raw entry is also allowed.
const RECUR: { label: string; rrule: string | null }[] = [
  { label: 'One-off', rrule: null },
  { label: 'Daily', rrule: 'FREQ=DAILY' },
  { label: 'Weekly', rrule: 'FREQ=WEEKLY' },
  { label: 'Every 2 weeks', rrule: 'FREQ=WEEKLY;INTERVAL=2' },
  { label: 'Monthly', rrule: 'FREQ=MONTHLY' },
];

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  accepted: 'Going',
  tentative: 'Maybe',
  declined: "Can't",
  'needs-action': '—',
};

function fmtDate(d: string): string {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function EventsPanel({ tabId, tabName, onClose, embedded }: { tabId: string; tabName: string; onClose: () => void; embedded?: boolean }) {
  const me = useSession((s) => s.user);
  const tab = useStore((s) => s.tabs[tabId]);
  const setTabLocation = useStore((s) => s.setTabLocation);

  const [events, setEvents] = useState<BoardEvent[] | null>(null);
  const [roster, setRoster] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-event form.
  const [start, setStart] = useState('');
  const [recur, setRecur] = useState<string | null>(null);

  async function refresh() {
    try {
      const { events, roster } = await api.events.list(tabId);
      setEvents(events);
      setRoster(Object.fromEntries(roster.map((r) => [r.userId, r.email])));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'failed to load events');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  function myStatus(occ: BoardEvent['occurrences'][number]): AttendanceStatus {
    return occ.attendance.find((a) => a.userId === me?.id)?.status ?? 'needs-action';
  }
  function goingEmails(occ: BoardEvent['occurrences'][number]): string[] {
    return occ.attendance.filter((a) => a.status === 'accepted').map((a) => roster[a.userId] ?? a.userId);
  }

  const body = (
    <>
      {error && <div className="share-error">{error}</div>}

      <label className="events-location">
          <span>Location</span>
          <input
            type="text"
            placeholder="add a place…"
            defaultValue={tab?.location ?? ''}
            onBlur={(e) => setTabLocation(tabId, e.target.value)}
          />
        </label>

        <div className="events-list">
          {events?.length === 0 && <div className="share-empty">No events yet.</div>}
          {events?.map((ev) => (
            <div key={ev.id} className="event-card">
              <div className="event-head">
                <span className="event-when">
                  {ev.start ? new Date(ev.start).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'no time'}
                  {ev.rrule && <em className="event-recur"> · repeats</em>}
                </span>
                <button className="icon-btn" disabled={busy} title="delete event" onClick={() => run(() => api.events.remove(ev.id))}>✕</button>
              </div>
              <div className="event-occurrences">
                {ev.occurrences.length === 0 && <span className="share-empty">No upcoming dates in the next 60 days.</span>}
                {ev.occurrences.map((occ) => {
                  const mine = myStatus(occ);
                  const going = goingEmails(occ);
                  return (
                    <div key={occ.date} className="occurrence">
                      <span className="occ-date">{fmtDate(occ.date)}</span>
                      <span className="occ-count" title={going.join(', ') || 'no one yet'}>{going.length} going</span>
                      <span className="occ-rsvp">
                        {(['accepted', 'tentative', 'declined'] as AttendanceStatus[]).map((st) => (
                          <button
                            key={st}
                            className={`rsvp-btn ${mine === st ? 'on' : ''}`}
                            disabled={busy}
                            onClick={() => run(() => api.events.rsvp(ev.id, occ.date, st))}
                          >
                            {STATUS_LABEL[st]}
                          </button>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!events && <div className="share-empty">Loading…</div>}
        </div>

        <form
          className="events-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!start) return;
            run(() => api.events.create(tabId, { start: new Date(start).toISOString(), rrule: recur }));
            setStart('');
          }}
        >
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} />
          <select value={recur ?? ''} onChange={(e) => setRecur(e.target.value || null)} disabled={busy}>
            {RECUR.map((r) => <option key={r.label} value={r.rrule ?? ''}>{r.label}</option>)}
          </select>
          <button type="submit" disabled={busy || !start}>Add event</button>
        </form>
    </>
  );

  if (embedded) return <div className="panel-embed">{body}</div>;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel events-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Schedule · {tabName}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>
        {body}
      </div>
    </div>
  );
}
