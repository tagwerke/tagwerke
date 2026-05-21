import { useStore } from '../store';
import { todayISO, formatDateChip } from '../util/dates';

export function TodayMiniCard() {
  const todayTabId = useStore((s) => s.todayTabId);
  const today = useStore((s) => s.tabs[s.todayTabId]);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const tasks = useStore((s) => s.tasks);
  const dateKey = today?.dateKey ?? todayISO();
  const blocks = today?.blocks ?? [];

  const totalRefs = blocks.reduce((n, b) => n + b.taskIds.length, 0);
  const done = blocks.reduce((n, b) => n + b.taskIds.filter((id) => tasks[id]?.done).length, 0);

  return (
    <button className="today-mini" onClick={() => setActiveTab(todayTabId)}>
      <div className="today-mini-top">
        <span className="today-mini-eyebrow">TODAY</span>
        <span className="today-mini-date">{formatDateChip(dateKey)}</span>
      </div>
      <div className="today-mini-stats">
        <span className="today-mini-num">{done}</span>
        <span className="today-mini-sep">/</span>
        <span className="today-mini-total">{totalRefs}</span>
        <span className="today-mini-label">{blocks.length} {blocks.length === 1 ? 'block' : 'blocks'}</span>
      </div>
      <div className="today-mini-cta">open →</div>
    </button>
  );
}
