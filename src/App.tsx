import { useEffect } from 'react';
import { useStore } from './store';
import { TopBar } from './components/TopBar';
import { StarredRow } from './components/StarredRow';
import { Board } from './components/Board';
import { TabView } from './components/TabView';
import { TodayView } from './components/TodayView';
import { SnapshotsPanel } from './components/Snapshots';

export default function App() {
  const activeTabId = useStore((s) => s.activeTabId);
  const todayTabId = useStore((s) => s.todayTabId);
  const tabs = useStore((s) => s.tabs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('open-search'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = activeTabId ? tabs[activeTabId] : null;

  return (
    <div className="app">
      <TopBar />
      {active ? (
        active.id === todayTabId ? <TodayView /> : <TabView tabId={active.id} />
      ) : (
        <>
          <StarredRow />
          <Board />
          <SnapshotsPanel />
        </>
      )}
    </div>
  );
}
