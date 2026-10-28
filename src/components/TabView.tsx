import { useEffect } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { TabEditor } from '../editor/Editor';
import { hexToRgba } from '../util/color';
import { BoardWork } from './board/BoardWork';
import { BACKLOG, useWorkFilters } from './board/workFilters';
import { ViewSwitcher } from './board/ViewSwitcher';
import { BoardSettings } from './settings/BoardSettings';
import { asBoardView, type BoardView } from '../types';

export function TabView({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs[tabId]);
  const project = useStore((s) => (tab ? s.projects[tab.projectId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const boardView = useStore((s) => s.boardView);
  const settingsOpen = useStore((s) => s.boardSettings !== null);
  const setBoardSettings = useStore((s) => s.setBoardSettings);
  const setBoardView = useStore((s) => s.setBoardView);
  // The board's work filters (sprints, assignees, search). Owned here, not in BoardWork, because
  // settings › Sprints drills into them. Sprint and assignee choices are remembered per board; the
  // search text is not (BOARD_FILTERS_PLAN D8).
  const [filters, updateFilters] = useWorkFilters(tabId);

  // Opening a board marks the viewer present in its board_activity row — what People's "seen 2h ago"
  // reads. Best-effort: presence is never worth an error.
  useEffect(() => {
    void api.activity.seen(tabId).catch(() => {});
  }, [tabId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Something inside already took this Escape — a cell menu closing, the table releasing its
        // cursor, settings closing. Those all preventDefault, and none of them meant "leave the board".
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement;
        if (target?.closest('.ProseMirror')) return;
        setActiveTab(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveTab]);

  if (!tab) return null;

  const accent = project?.color ?? '#888';
  const style = {
    '--page-accent': accent,
    '--page-accent-soft': hexToRgba(accent, 0.1),
  } as React.CSSProperties;
  const isBoard = tab.type !== 'today';
  // Normalised, never trusted: an older client, a restored session or a stale link must land
  // on the table rather than on a view that no longer exists (§N2.4).
  const normalized: BoardView = isBoard ? asBoardView(boardView) : 'notes';
  // A non-admin never lands on Secrets — e.g. the view was left on it and the next board opened is
  // one where they are only an editor.
  const view: BoardView = normalized === 'secrets' && tab.role !== 'admin' ? 'table' : normalized;

  return (
    <main className="tab-view tab-open" style={style}>
      <div className="board-canvas no-panel">
        <div className="board-content">
          {view === 'notes' ? (
            <>
              <div className="work-toolbar notes-toolbar">
                <div className="scope-right"><ViewSwitcher view={view} onChange={setBoardView} /></div>
              </div>
              <div className="tab-view-body"><TabEditor tabId={tab.id} autoFocus /></div>
            </>
          ) : (
            /* `view` is normalised by asBoardView, so there is no fall-through branch to land a
               deleted view in. */
            <BoardWork
              key={tab.id}
              tabId={tab.id}
              filters={filters}
              onFilters={updateFilters}
              view={view}
              onViewChange={setBoardView}
            />
          )}
        </div>
      </div>

      {isBoard && settingsOpen && (
        <BoardSettings
          key={tab.id}
          tabId={tab.id}
          onOpenSprint={(id) => {
            updateFilters((f) => ({ ...f, sprints: [id ?? BACKLOG], assignees: [] }));
            setBoardView('table');
            setBoardSettings(null);
          }}
        />
      )}
    </main>
  );
}
