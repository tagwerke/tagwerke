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
import { ImportCsvSheet } from './components/ImportCsvSheet';
import { FilterPanel } from './components/FilterPanel';
import { SearchPalette } from './components/SearchPalette';
import { AdminPage } from './components/AdminPage';
import { SecurityPanel } from './components/SecurityPanel';
import { MoreSheet } from './components/MoreSheet';
import { NotificationsPanel } from './components/NotificationsPanel';
import { CascadeToast } from './components/common/CascadeToast';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { Toast } from './components/common/Toast';
import { InfoPane } from './components/InfoPane';
import { TaskPage } from './components/TaskPage';
import {
  usePath,
  boardPath,
  parseBoardId,
  isCalendarPath,
  CALENDAR_PATH,
  boardSprintsPath,
  isBoardSprintsPath,
  boardTaskPath,
  parseOpenTaskId,
} from './util/router';

export type Panel = 'new' | 'import' | 'filter' | 'search' | 'security' | 'more' | 'notifications' | 'help';

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
  // ConfirmDialog is mounted alongside BOTH authenticated trees, not inside Workspace: /admin is a
  // separate top-level page and its console has destructive actions of its own.
  // /admin is its own page (no link to it — type the URL). It self-bounces non-admins.
  if (path === '/admin') {
    return (
      <>
        <AdminPage />
        <ConfirmDialog />
      </>
    );
  }
  return (
    <>
      <Workspace />
      <ConfirmDialog />
    </>
  );
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

  // The help modal is InfoPane wrapped for standalone use (it has no Escape handling of its own —
  // its other home, swapped inline into an open board, closes via its own "x" button instead).
  useEffect(() => {
    if (panel !== 'help') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  // Navigation lives in the URL so a refresh (or a shared link) restores the open board, the
  // calendar, the sprints page, or an open task. URL → store: whenever the path changes
  // (initial load, back/forward), reflect it. /calendar the calendar; /b/:id a board;
  // /b/:id/sprints its sprints page; /b/:id/task/:taskId an open task page; / the grid.
  const path = usePath();
  useEffect(() => {
    const st = useStore.getState();
    if (isCalendarPath(path)) {
      if (!st.plannerOpen) useStore.setState({ plannerOpen: true, activeTabId: null });
      return;
    }
    if (st.plannerOpen) useStore.setState({ plannerOpen: false });
    const id = parseBoardId(path);
    const taskId = id ? parseOpenTaskId(path) : null;
    const wantSprints = id ? isBoardSprintsPath(path) : false;
    if (st.activeTabId !== id) {
      // A different (or no) board: full reset, same as setActiveTab, but landing on whatever
      // sub-route the URL actually names instead of always defaulting to doc.
      useStore.setState({ activeTabId: id, boardView: wantSprints ? 'sprints' : 'doc', openTaskId: taskId, plannerOpen: false });
      return;
    }
    // Same board: only reconcile the pieces the URL disagrees with — e.g. opening/closing the
    // task page must not reset which of list/kanban/calendar was showing underneath it.
    const patch: { openTaskId?: string | null; boardView?: typeof st.boardView } = {};
    if (st.openTaskId !== taskId) patch.openTaskId = taskId;
    const wantBoardView = wantSprints ? 'sprints' : st.boardView === 'sprints' ? 'doc' : st.boardView;
    if (wantBoardView !== st.boardView) patch.boardView = wantBoardView;
    if (Object.keys(patch).length) useStore.setState(patch);
  }, [path]);
  // store → URL: when the open board, calendar, sprints page, or open task changes from
  // within the app, update the address bar. subscribe() only fires on an actual change, so it
  // never clobbers a deeper URL present on first paint. Every distinct destination gets its own
  // pushState (never replaceState) so back/forward steps through boards/task pages naturally.
  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      if (
        s.activeTabId === prev.activeTabId &&
        s.plannerOpen === prev.plannerOpen &&
        s.boardView === prev.boardView &&
        s.openTaskId === prev.openTaskId
      )
        return;
      let want: string;
      if (s.plannerOpen) want = CALENDAR_PATH;
      else if (!s.activeTabId) want = '/';
      else if (s.openTaskId) want = boardTaskPath(s.activeTabId, s.openTaskId);
      else if (s.boardView === 'sprints') want = boardSprintsPath(s.activeTabId);
      else want = boardPath(s.activeTabId);
      if (window.location.pathname !== want) window.history.pushState(null, '', want);
    });
  }, []);

  const active = activeTabId ? tabs[activeTabId] : null;
  const openTaskId = useStore((s) => s.openTaskId);

  return (
    <div className="app-shell">
      <Sidebar onOpen={setPanel} />
      <div className="main">
        <TopBar onOpen={setPanel} />
        {plannerOpen ? (
          <CalendarView />
        ) : active && openTaskId ? (
          <TaskPage taskId={openTaskId} boardId={active.id} />
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
      <CascadeToast />
      <Toast />

      {panel === 'new' && <NewTabDialog onClose={closePanel} />}
      {panel === 'import' && <ImportCsvSheet onClose={closePanel} />}
      {panel === 'filter' && <FilterPanel onClose={closePanel} />}
      {panel === 'search' && <SearchPalette onClose={closePanel} />}
      {panel === 'security' && <SecurityPanel onClose={closePanel} />}
      {panel === 'notifications' && <NotificationsPanel onClose={closePanel} />}
      {panel === 'more' && <MoreSheet onClose={closePanel} onOpen={setPanel} />}
      {panel === 'help' && (
        <div className="modal-backdrop" onClick={closePanel}>
          <div className="info-modal" onClick={(e) => e.stopPropagation()}>
            <InfoPane kind="help" onClose={closePanel} />
          </div>
        </div>
      )}
    </div>
  );
}
