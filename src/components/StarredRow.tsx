import { useStore } from '../store';
import { TodayMiniCard } from './TodayMiniCard';
import { TabCard } from './TabCard';

export function StarredRow() {
  const todayTabId = useStore((s) => s.todayTabId);
  const starredOrder = useStore((s) => s.starredRowOrder);
  const tabs = useStore((s) => s.tabs);

  const starred = starredOrder
    .map((id) => tabs[id])
    .filter((t) => t && t.id !== todayTabId);

  return (
    <section className="loadout">
      <header className="loadout-header">
        <span className="loadout-label">Loadout</span>
        <span className="loadout-hint">your active set</span>
      </header>
      <div className="loadout-row">
        <TodayMiniCard />
        {starred.map((t) => (
          <div key={t.id} className="loadout-tab"><TabCard tabId={t.id} compact /></div>
        ))}
      </div>
    </section>
  );
}
