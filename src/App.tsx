import { useEffect } from 'react';
import { useStore } from './store';
import { useSession } from './session/useSession';
import { AuthScreen } from './components/AuthScreen';
import { TopBar } from './components/TopBar';
import { StarredRow } from './components/StarredRow';
import { Board } from './components/Board';
import { TabView } from './components/TabView';
import { TodayView } from './components/TodayView';
import { SnapshotsPanel } from './components/Snapshots';

export default function App() {
  const status = useSession((s) => s.status);
  const init = useSession((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (status === 'loading') {
    return <div className="app app-loading" />;
  }
  if (status === 'unauthenticated') {
    return <AuthScreen />;
  }
  return <Workspace />;
}

function Workspace() {
  const activeTabId = useStore((s) => s.activeTabId);
  const todayTabId = useStore((s) => s.todayTabId);
  const tabs = useStore((s) => s.tabs);
  const cleanupEmptyTasks = useStore((s) => s.cleanupEmptyTasks);

  useEffect(() => {
    cleanupEmptyTasks();
  }, [cleanupEmptyTasks]);

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
