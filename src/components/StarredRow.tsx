import { useStore } from '../store';
import { TabCard } from './TabCard';

export function StarredRow() {
  const starredOrder = useStore((s) => s.starredRowOrder);
  const tabs = useStore((s) => s.tabs);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const starred = starredOrder
    .map((id) => tabs[id])
    .filter((t) => t && t.type !== 'today');

  return (
    <section className="loadout">
      <header className="loadout-header">
        <span className="loadout-label">Loadout</span>
        <span className="loadout-hint">your active set</span>
      </header>
      <div className="loadout-row">
        <button className="loadout-planner" onClick={() => setPlannerOpen(true)} title="Open the Planner">
          <span className="loadout-planner-label">Planner</span>
          <span className="loadout-planner-hint">plan your day →</span>
        </button>
        {starred.map((t) => (
          <div key={t.id} className="loadout-tab"><TabCard tabId={t.id} compact /></div>
        ))}
      </div>
    </section>
  );
}
