import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { TabEditor } from '../editor/Editor';
import { hexToRgba } from '../util/color';
import { usePresence } from '../realtime/usePresence';
import { Avatar } from './common/Avatar';
import { BoardPanel } from './BoardPanel';
import { BoardWork } from './board/BoardWork';
import { ViewSwitcher } from './board/ViewSwitcher';
import { Dropdown } from './Dropdown';
import { InfoPane } from './InfoPane';
import { useHelpBadge } from '../help/useHelpBadge';
import { asBoardView, type BoardView, type ID } from '../types';


/** A sprint filter for List/Kanban: a specific sprint id, `null` for backlog, or 'all' for no
 *  filter. Not persisted — reopening a board (or the Sprints page's own "view all") clears it. */
export type SprintFilter = ID | null | 'all';

/** Live cursors present in this board, as ringed avatars (self excluded, deduped by name). */
function PresenceAvatars({ tabId }: { tabId: string }) {
  const peers = usePresence(tabId).filter((p) => !p.self);
  const seen = new Set<string>();
  const uniq = peers.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
  if (!uniq.length) return null;
  return (
    <div className="presence avatar-stack" title={`${uniq.length} editing now`}>
      {uniq.slice(0, 4).map((p) => (
        <Avatar key={p.clientId} name={p.name} color={p.color} size={26} ring title={`${p.name} — here now`} />
      ))}
    </div>
  );
}

export function TabView({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs[tabId]);
  const project = useStore((s) => (tab ? s.projects[tab.projectId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const renameTab = useStore((s) => s.renameTab);
  const setTabStarred = useStore((s) => s.setTabStarred);
  const boardView = useStore((s) => s.boardView);
  const boardPanel = useStore((s) => s.boardPanel);
  const projects = useStore((s) => s.projects);
  const setTabProject = useStore((s) => s.setTabProject);
  const projectOptions = useMemo(
    () => Object.values(projects)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ value: p.id, label: p.name, accent: p.color })),
    [projects],
  );
  const setBoardView = useStore((s) => s.setBoardView);
  const [panelOpen, setPanelOpen] = useState(true);
  // Which sprint List/Kanban show. Defaults to 'all' (unfiltered) — every task that existed
  // before sprints shipped has no sprintId at all, i.e. is in the backlog, so defaulting to
  // "current sprint" would render an empty view on every pre-existing board. Filtering to one
  // sprint is an explicit action (drilling in from the Sprints page), never the default.
  // Deliberately NOT persisted — reset whenever the board itself changes.
  const [sprintFilter, setSprintFilter] = useState<SprintFilter>('all');
  useEffect(() => {
    setSprintFilter('all');
  }, [tabId]);
  // Not part of `boardView`/global store on purpose — it's an auxiliary pane, not a view of the
  // board's task data, and must never persist as "the" view a board reopens into.
  const [pane, setPane] = useState<'help' | null>(null);
  const { hasNew: hasNewHelp } = useHelpBadge();
  // The title as it stood when editing began, so an emptied field can be put back on blur.
  const titleOnFocus = useRef(tab?.name ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
  const view: BoardView = isBoard ? asBoardView(boardView) : 'notes';

  return (
    <main className="tab-view tab-open" style={style}>
      {/* Getting back out of a board is app navigation, not part of the board. It sits above the
          header so the title has nothing competing with it. */}
      <nav className="board-crumb">
        <button className="back-btn" onClick={() => setActiveTab(null)} aria-label="back to boards">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>Boards</span>
        </button>
      </nav>

      <header className="board-head">
        <div className="board-head-title">
          {/* The project is a choice, not a label: a board moves between projects from inside
              itself rather than only from the grid it is filed in. */}
          {isBoard && projectOptions.length > 0 ? (
            <Dropdown
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
        {/* Three small board-level controls, together: help, star, panel. They act on the board
            as a whole, which is what makes them one group rather than three strays. */}
        <div className="board-head-right">
          {isBoard && <PresenceAvatars tabId={tab.id} />}
          {isBoard && (
            <button
              className={`icon-btn help-btn ${pane === 'help' ? 'on' : ''}`}
              onClick={() => setPane((p) => (p === 'help' ? null : 'help'))}
              aria-label="how to use Tagwerke"
              title="How to use Tagwerke"
            >
              ?
              {hasNewHelp && pane !== 'help' && <span className="help-btn-dot" aria-label="new" />}
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
          {isBoard && (
            <button className={`icon-btn panel-toggle ${panelOpen ? 'on' : ''}`} onClick={() => setPanelOpen((v) => !v)} aria-label="board panel" title="Board panel">
              <svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M10 3v10" stroke="currentColor" strokeWidth="1.3"/></svg>
            </button>
          )}
        </div>
      </header>

      <div className={`board-canvas ${isBoard && panelOpen ? '' : 'no-panel'}`}>
        <div className="board-content">
          {pane === 'help' ? (
            <InfoPane kind="help" onClose={() => setPane(null)} />
          ) : view === 'notes' ? (
            <>
              <div className="work-toolbar notes-toolbar">
                <span className="work-spacer" />
                <ViewSwitcher view={view} onChange={setBoardView} />
              </div>
              <div className="tab-view-body"><TabEditor tabId={tab.id} autoFocus /></div>
            </>
          ) : (
            /* Table and Kanban are one component, two layouts — so grouping, filters and the
               scope switch survive a switch between them (§N2.1). `view` is normalised by
               asBoardView, so there is no fall-through branch to land a deleted view in. */
            <BoardWork tabId={tab.id} layout={view === 'kanban' ? 'board' : 'table'} sprintFilter={sprintFilter} view={view} onViewChange={setBoardView} />
          )}
        </div>
        {isBoard && panelOpen && (
          <BoardPanel
            tabId={tab.id}
            tabName={tab.name}
            initialTab={boardPanel ?? undefined}
            onOpenSprint={(id) => {
              setSprintFilter(id);
              setBoardView('table');
            }}
          />
        )}
      </div>
    </main>
  );
}
