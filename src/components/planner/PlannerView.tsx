// The Planner replaces the old Today aggregation tab. It is a day/week calendar of
// TIME BLOCKS, each of which references a whole tab (board) and projects that board's
// LIVE tasks — no copy, no doc sync. Your own blocks are editable; teammates' blocks on
// boards you share render read-only ("who's-on-what-today").

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { api, drain, ApiError, type TimeBlockOut } from '../../api/client';
import { toISO, formatDateChip } from '../../util/dates';
import type { BlockFilter, ID, TimeBlock } from '../../types';
import { TimeBlockCard } from './TimeBlockCard';

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

/** Normalize a fetched row into the client TimeBlock shape (filter -> BlockFilter). */
function toBlock(o: TimeBlockOut): TimeBlock {
  return { ...o, filter: (o.filter as BlockFilter | null) ?? null };
}

export function PlannerView() {
  const me = useSession((s) => s.user);
  const ownBlocks = useStore((s) => s.timeBlocks);
  const plannerDate = useStore((s) => s.plannerDate);
  const plannerMode = useStore((s) => s.plannerMode);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);
  const setPlannerDate = useStore((s) => s.setPlannerDate);
  const setPlannerMode = useStore((s) => s.setPlannerMode);
  const setOwnTimeBlocks = useStore((s) => s.setOwnTimeBlocks);
  const createTimeBlock = useStore((s) => s.createTimeBlock);
  const tabs = useStore((s) => s.tabs);
  const tabOrder = useStore((s) => s.tabOrder);
  const firstTabId = tabOrder.find((id) => tabs[id]?.type === 'normal');

  const [teammateBlocks, setTeammateBlocks] = useState<TimeBlock[]>([]);
  const [roster, setRoster] = useState<Record<ID, string>>({});
  const [error, setError] = useState<string | null>(null);

  const { from, to, days } = windowFor(plannerDate, plannerMode);

  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      await drain(); // ensure optimistic writes settled before we re-read
      const { blocks, roster } = await api.timeBlocks.list(from, to);
      setOwnTimeBlocks(blocks.filter((b) => b.userId === me.id).map(toBlock));
      setTeammateBlocks(blocks.filter((b) => b.userId !== me.id).map(toBlock));
      setRoster(Object.fromEntries(roster.map((r) => [r.userId, r.email])));
      setError(null);
    } catch (e) {
      // Offline: your own blocks still render from the store; only teammates' lanes
      // and live refresh are unavailable, so keep it quiet rather than alarming.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setError('offline — showing your saved blocks');
      } else {
        setError(e instanceof ApiError ? e.message : 'failed to load planner');
      }
    }
  }, [me, from, to, setOwnTimeBlocks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlannerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPlannerOpen]);

  const step = plannerMode === 'week' ? 7 : 1;

  return (
    <main className="planner">
      <header className="planner-head">
        <button className="back-btn" onClick={() => setPlannerOpen(false)} aria-label="back">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>board</span>
        </button>
        <div className="planner-nav">
          <button className="icon-btn" onClick={() => setPlannerDate(shiftDate(plannerDate, -step))} aria-label="previous">‹</button>
          <button className="btn ghost" onClick={() => setPlannerDate(toISO(new Date()))}>today</button>
          <button className="icon-btn" onClick={() => setPlannerDate(shiftDate(plannerDate, step))} aria-label="next">›</button>
          <input type="date" className="planner-date-input" value={plannerDate} onChange={(e) => e.target.value && setPlannerDate(e.target.value)} />
        </div>
        <div className="planner-modes">
          <button className={`btn ghost ${plannerMode === 'day' ? 'is-active' : ''}`} onClick={() => setPlannerMode('day')}>day</button>
          <button className={`btn ghost ${plannerMode === 'week' ? 'is-active' : ''}`} onClick={() => setPlannerMode('week')}>week</button>
        </div>
      </header>

      {error && <div className="planner-error">{error}</div>}

      <div className={`planner-grid mode-${plannerMode}`}>
        {days.map((day) => {
          const own = Object.values(ownBlocks).filter((b) => b.date === day).sort((a, b) => a.position - b.position);
          const mates = teammateBlocks.filter((b) => b.date === day);
          const byMate = new Map<ID, TimeBlock[]>();
          for (const b of mates) byMate.set(b.userId, [...(byMate.get(b.userId) ?? []), b]);
          return (
            <section className="planner-day" key={day}>
              <header className="planner-day-head">
                <span className="planner-day-name">{formatDateChip(day)}</span>
                <span className="planner-day-date">{day}</span>
              </header>

              <div className="planner-lane">
                {own.map((b) => <TimeBlockCard key={b.id} block={b} />)}
                <button
                  className="planner-add"
                  disabled={!firstTabId || !me}
                  onClick={() => me && firstTabId && createTimeBlock({ userId: me.id, tabId: firstTabId, date: day })}
                >+ time block</button>
              </div>

              {[...byMate.entries()].map(([userId, blocks]) => (
                <div className="planner-mate-lane" key={userId}>
                  <div className="planner-mate-name">{roster[userId]?.split('@')[0] ?? 'teammate'}</div>
                  {blocks.map((b) => <TimeBlockCard key={b.id} block={b} readOnly ownerLabel={roster[userId]} />)}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}
