import { useEffect } from 'react';
import { useStore } from '../store';
import { TodayBlockView } from './TodayBlockView';
import { todayISO, formatDateChip } from '../util/dates';

export function TodayView() {
  const today = useStore((s) => s.tabs[s.todayTabId]);
  const todayTabId = useStore((s) => s.todayTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const addBlock = useStore((s) => s.addBlock);
  const freezeToday = useStore((s) => s.freezeToday);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveTab(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveTab]);

  if (!today) return null;
  const blocks = today.blocks ?? [];
  const dateKey = today.dateKey ?? todayISO();

  return (
    <main className="today-view">
      <header className="today-head">
        <button className="back-btn" onClick={() => setActiveTab(null)} aria-label="back">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>board</span>
        </button>
        <div className="today-head-titles">
          <h1>TODAY</h1>
          <span className="today-head-date">{formatDateChip(dateKey)} · {dateKey}</span>
        </div>
        <div className="today-head-actions">
          <button className="btn ghost" onClick={() => {
            if (!confirm('Freeze the current TODAY into a snapshot and clear it for a new day?')) return;
            freezeToday();
          }}>freeze day</button>
          <button className="btn primary" onClick={() => addBlock()}>+ block</button>
        </div>
      </header>

      <div className="today-blocks">
        {blocks.length === 0 ? (
          <div className="today-empty">
            <p>no blocks yet — plan your day in time-boxes.</p>
            <button className="btn primary" onClick={() => addBlock()}>+ first block</button>
          </div>
        ) : (
          blocks.map((b, i) => (
            <TodayBlockView blockId={b.id} key={b.id} index={i} todayTabId={todayTabId} />
          ))
        )}
      </div>
    </main>
  );
}
