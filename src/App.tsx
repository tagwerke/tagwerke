import { useEffect, useState } from 'react';
import { useStore } from './store';
import { useSession } from './session/useSession';
import { AuthScreen } from './components/AuthScreen';
import { TopBar } from './components/TopBar';
import { MobileNav } from './components/MobileNav';
import { StarredRow } from './components/StarredRow';
import { Board } from './components/Board';
import { TabView } from './components/TabView';
import { PlannerView } from './components/planner/PlannerView';
import { NewTabDialog } from './components/NewTabDialog';
import { FilterPanel } from './components/FilterPanel';
import { SearchPalette } from './components/SearchPalette';
import { AdminPanel } from './components/AdminPanel';
import { MoreSheet } from './components/MoreSheet';

export type Panel = 'new' | 'filter' | 'search' | 'admin' | 'more';

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
  const plannerOpen = useStore((s) => s.plannerOpen);
  const tabs = useStore((s) => s.tabs);
  const cleanupEmptyTasks = useStore((s) => s.cleanupEmptyTasks);
  const [panel, setPanel] = useState<Panel | null>(null);
  const closePanel = () => setPanel(null);

  useEffect(() => {
    cleanupEmptyTasks();
  }, [cleanupEmptyTasks]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPanel('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = activeTabId ? tabs[activeTabId] : null;

  return (
    <div className="app">
      <TopBar onOpen={setPanel} />
      {plannerOpen ? (
        <PlannerView />
      ) : active ? (
        <TabView tabId={active.id} />
      ) : (
        <>
          <StarredRow />
          <Board />
        </>
      )}
      <MobileNav onOpen={setPanel} />

      {panel === 'new' && <NewTabDialog onClose={closePanel} />}
      {panel === 'filter' && <FilterPanel onClose={closePanel} />}
      {panel === 'search' && <SearchPalette onClose={closePanel} />}
      {panel === 'admin' && <AdminPanel onClose={closePanel} />}
      {panel === 'more' && <MoreSheet onClose={closePanel} onOpen={setPanel} />}
    </div>
  );
}
