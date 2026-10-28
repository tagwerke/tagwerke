import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { TabEditor } from '../editor/Editor';
import { hexToRgba } from '../util/color';
import { usePresence } from '../realtime/usePresence';
import { Avatar } from './common/Avatar';
import { BoardWork } from './board/BoardWork';
import { BoardMenu } from './board/BoardMenu';
import { BACKLOG, useWorkFilters } from './board/workFilters';
import { ViewSwitcher } from './board/ViewSwitcher';
import { BoardSettings } from './settings/BoardSettings';
import { Dropdown } from './Dropdown';
import { asBoardView, type BoardView } from '../types';


/** Live cursors present in this board, as ringed avatars (self excluded, deduped by name). They
 *  open People: who is here now is the first thing that list is about. */
function PresenceAvatars({ tabId, onOpen }: { tabId: string; onOpen: () => void }) {
  const peers = usePresence(tabId).filter((p) => !p.self);
  const seen = new Set<string>();
  const uniq = peers.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
  if (!uniq.length) return null;
  return (
    <button className="icon-btn presence avatar-stack" onClick={onOpen} title={`${uniq.length} editing now`} aria-label={`${uniq.length} editing now. Open People`}>
      {uniq.slice(0, 4).map((p) => (
        <Avatar key={p.clientId} name={p.name} color={p.color} size={26} ring title={`${p.name} — here now`} />
      ))}
    </button>
  );
}

export function TabView({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs[tabId]);
  const project = useStore((s) => (tab ? s.projects[tab.projectId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const renameTab = useStore((s) => s.renameTab);
  const setTabStarred = useStore((s) => s.setTabStarred);
  const boardView = useStore((s) => s.boardView);
  const projects = useStore((s) => s.projects);
  const setTabProject = useStore((s) => s.setTabProject);
  const settingsOpen = useStore((s) => s.boardSettings !== null);
  const openBoardSettings = useStore((s) => s.openBoardSettings);
  const setBoardSettings = useStore((s) => s.setBoardSettings);
  const projectOptions = useMemo(
    () => Object.values(projects)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ value: p.id, label: p.name, accent: p.color })),
    [projects],
  );
  const setBoardView = useStore((s) => s.setBoardView);
  // The board's work filters (sprints, assignees, search). Owned here, not in BoardWork, because
  // settings › Sprints drills into them. Sprint and assignee choices are remembered per board; the
  // search text is not (BOARD_FILTERS_PLAN D8).
  const [filters, updateFilters] = useWorkFilters(tabId);
  // The title as it stood when editing began, so an emptied field can be put back on blur.
  const titleOnFocus = useRef(tab?.name ?? '');

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
      <header className="board-head">
        <div className="board-head-title">
          {/* The project is a choice, not a label: a board moves between projects from inside
              itself rather than only from the grid it is filed in. */}
          {isBoard && projectOptions.length > 0 ? (
            <Dropdown
              className="is-chip"
              value={tab.projectId}
              options={projectOptions}
              onChange={(id) => setTabProject(tab.id, id)}
              placeholder="Project"
            />
          ) : project ? (
            <span className="board-eyebrow">{project.name}</span>
          ) : null}
          <input
            className="board-title"
            value={tab.name}
            onFocus={() => { titleOnFocus.current = tab.name; }}
            onChange={(e) => renameTab(tab.id, e.target.value)}
            // A board must have a name (both PATCH routes require one), so an emptied field is an
            // editing state, not a value: nothing was sent for it, and leaving it would strand the
            // store on a blank the next re-pull would silently overwrite. Put back whatever was
            // there on focus — which is also correct if a different name was typed and sent first.
            onBlur={() => { if (!tab.name.trim()) renameTab(tab.id, titleOnFocus.current); }}
            aria-label="board title"
          />
        </div>
        {/* Board-level controls only — app-level ones (search, help, notifications) are in the top
            bar. Everything about the board beyond its name and star is in its settings, which these
            open: Share and the live avatars at People, the ⋯ menu at the rest. */}
        <div className="board-head-right">
          {isBoard && <PresenceAvatars tabId={tab.id} onOpen={() => openBoardSettings(tab.id, 'people')} />}
          {isBoard && (
            <button className="btn primary" onClick={() => openBoardSettings(tab.id, 'people')}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="M6 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 13.5c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4M12.5 5v4M10.5 7h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Share</span>
            </button>
          )}
          <button
            className={`icon-btn star ${tab.starred ? 'on' : ''}`}
            onClick={() => setTabStarred(tab.id, !tab.starred)}
            aria-label="star"
            title={tab.starred ? 'unstar' : 'star'}
          >
            <svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.7l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.6l-3.9 1.9.9-4.3-3.3-3 4.4-.5z" fill={tab.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
          {isBoard && <BoardMenu tabId={tab.id} />}
        </div>
      </header>

      <div className="board-canvas no-panel">
        <div className="board-content">
          {view === 'notes' ? (
            <>
              <div className="work-toolbar notes-toolbar">
                <span className="work-spacer" />
                <ViewSwitcher view={view} onChange={setBoardView} />
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
