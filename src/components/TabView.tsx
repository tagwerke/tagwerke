import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { TabEditor } from '../editor/Editor';
import { hexToRgba } from '../util/color';
import { usePresence } from '../realtime/usePresence';
import { Avatar } from './common/Avatar';
import { BoardPanel } from './BoardPanel';
import { BoardList } from './BoardList';
import { BoardKanban } from './BoardKanban';
import { BoardCalendar } from './BoardCalendar';
import { InfoPane } from './InfoPane';
import { useHelpBadge } from '../help/useHelpBadge';
import type { BoardView } from '../types';

const VIEW_LABEL: Record<BoardView, string> = { doc: 'Doc', list: 'List', kanban: 'Kanban', calendar: 'Calendar' };
const VIEWS: BoardView[] = ['doc', 'list', 'kanban', 'calendar'];

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
  const setBoardView = useStore((s) => s.setBoardView);
  const [panelOpen, setPanelOpen] = useState(true);
  // Not part of `boardView`/global store on purpose — it's an auxiliary pane, not a view of the
  // board's task data, and must never persist as "the" view a board reopens into.
  const [pane, setPane] = useState<'help' | null>(null);
  const { hasNew: hasNewHelp } = useHelpBadge();

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
  const view = isBoard ? boardView : 'doc';

  return (
    <main className="tab-view tab-open" style={style}>
      <header className="board-head">
        <button className="back-btn" onClick={() => setActiveTab(null)} aria-label="back to boards">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>Boards</span>
        </button>
        <div className="board-head-title">
          {project && <span className="board-eyebrow">{project.name}</span>}
          <input className="board-title" value={tab.name} onChange={(e) => renameTab(tab.id, e.target.value)} aria-label="board title" />
        </div>
        <button
          className={`icon-btn star ${tab.starred ? 'on' : ''}`}
          onClick={() => setTabStarred(tab.id, !tab.starred)}
          aria-label="star"
          title={tab.starred ? 'unstar' : 'star'}
        >
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.7l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.6l-3.9 1.9.9-4.3-3.3-3 4.4-.5z" fill={tab.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        <div className="board-head-right">
          {isBoard && <PresenceAvatars tabId={tab.id} />}
          {isBoard && (
            <button className={`icon-btn panel-toggle ${panelOpen ? 'on' : ''}`} onClick={() => setPanelOpen((v) => !v)} aria-label="board panel" title="Board panel">
              <svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M10 3v10" stroke="currentColor" strokeWidth="1.3"/></svg>
            </button>
          )}
        </div>
      </header>

      {isBoard && (
        <div className="board-toolbar">
          <div className="seg board-views">
            {VIEWS.map((v) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => setBoardView(v)}>{VIEW_LABEL[v]}</button>
            ))}
          </div>
          <button
            className={`icon-btn help-btn ${pane === 'help' ? 'on' : ''}`}
            onClick={() => setPane((p) => (p === 'help' ? null : 'help'))}
            aria-label="how to use Tagwerke"
            title="How to use Tagwerke"
          >
            ?
            {hasNewHelp && pane !== 'help' && <span className="help-btn-dot" aria-label="new" />}
          </button>
        </div>
      )}

      <div className={`board-canvas ${isBoard && panelOpen ? '' : 'no-panel'}`}>
        <div className="board-content">
          {pane === 'help' ? (
            <InfoPane kind="help" onClose={() => setPane(null)} />
          ) : view === 'doc' ? (
            <div className="tab-view-body"><TabEditor tabId={tab.id} autoFocus /></div>
          ) : view === 'list' ? (
            <BoardList tabId={tab.id} />
          ) : view === 'kanban' ? (
            <BoardKanban tabId={tab.id} />
          ) : (
            <BoardCalendar tabId={tab.id} />
          )}
        </div>
        {isBoard && panelOpen && <BoardPanel tabId={tab.id} tabName={tab.name} />}
      </div>
    </main>
  );
}
