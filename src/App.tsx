import { useEffect, useState } from 'react';
import { useStore } from './store';
import { useSession } from './session/useSession';
import { AuthScreen } from './components/AuthScreen';
import { TopBar } from './components/TopBar';
import { MobileNav } from './components/MobileNav';
import { Sidebar } from './components/shell/Sidebar';
import { ScopeStrip } from './components/shell/ScopeStrip';
import { Board } from './components/Board';
import { TabView } from './components/TabView';
import { CalendarView } from './components/calendar/CalendarView';
import { NewTabDialog } from './components/NewTabDialog';
import { FilterPanel } from './components/FilterPanel';
import { SearchPalette } from './components/SearchPalette';
import { AdminPage } from './components/AdminPage';
import { SecurityPanel } from './components/SecurityPanel';
import { MoreSheet } from './components/MoreSheet';
import { NotificationsPanel } from './components/NotificationsPanel';
import { usePath, boardPath, parseBoardId, isCalendarPath, CALENDAR_PATH } from './util/router';

export type Panel = 'new' | 'filter' | 'search' | 'security' | 'more' | 'notifications';

export default function App() {
  const status = useSession((s) => s.status);
  const init = useSession((s) => s.init);
  const path = usePath();

  useEffect(() => {
    void init();
  }, [init]);

  if (status === 'loading') {
    return <div className="app app-loading" />;
  }
  if (status === 'unauthenticated') {
    return <AuthScreen />;
  }
  // /admin is its own page (no link to it — type the URL). It self-bounces non-admins.
  if (path === '/admin') {
    return <AdminPage />;
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

  // Navigation lives in the URL so a refresh (or a shared link) restores the open board or
  // the calendar. URL → store: whenever the path changes (initial load, back/forward),
  // reflect it. /calendar drives the calendar; /b/:id a board; / the grid.
  const path = usePath();
  useEffect(() => {
    const st = useStore.getState();
    if (isCalendarPath(path)) {
      if (!st.plannerOpen) useStore.setState({ plannerOpen: true, activeTabId: null });
      return;
    }
    if (st.plannerOpen) useStore.setState({ plannerOpen: false });
    const id = parseBoardId(path);
    if (st.activeTabId !== id) st.setActiveTab(id);
  }, [path]);
  // store → URL: when the open board or calendar changes from within the app, update the
  // address bar. subscribe() only fires on an actual change, so it never clobbers a deeper
  // URL present on first paint.
  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      if (s.activeTabId === prev.activeTabId && s.plannerOpen === prev.plannerOpen) return;
      const want = s.plannerOpen ? CALENDAR_PATH : boardPath(s.activeTabId);
      if (window.location.pathname !== want) window.history.pushState(null, '', want);
    });
  }, []);

  const active = activeTabId ? tabs[activeTabId] : null;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <TopBar onOpen={setPanel} />
        {plannerOpen ? (
          <CalendarView />
        ) : active ? (
          <TabView tabId={active.id} />
        ) : (
          <>
            <ScopeStrip />
            <Board />
          </>
        )}
      </div>
      <MobileNav onOpen={setPanel} />

      {panel === 'new' && <NewTabDialog onClose={closePanel} />}
      {panel === 'filter' && <FilterPanel onClose={closePanel} />}
      {panel === 'search' && <SearchPalette onClose={closePanel} />}
      {panel === 'security' && <SecurityPanel onClose={closePanel} />}
      {panel === 'notifications' && <NotificationsPanel onClose={closePanel} />}
      {panel === 'more' && <MoreSheet onClose={closePanel} onOpen={setPanel} />}
    </div>
  );
}
