// The open board's companion rail: one panel, single-purpose tabs. Replaces the old
// separate Share / Schedule modals. Each tab embeds the existing panel body:
//   Members  — roster, roles, invite, board rules  (SharePanel, embedded)
//   Events   — agenda, location, RSVP              (EventsPanel, embedded)
//   Activity — presence + board history + trash    (BoardActivity + ActivityDrawer/TrashPanel)
// On desktop it's a persistent right rail; on mobile TabView mounts it inside a Sheet.

import { useState } from 'react';
import { useStore } from '../store';
import { SharePanel } from './SharePanel';
import { EventsPanel } from './EventsPanel';
import { BoardActivity } from './BoardActivity';
import { ActivityDrawer } from './ActivityDrawer';
import { TrashPanel } from './TrashPanel';
import { SprintsPage } from './SprintsPage';

type PanelTab = 'members' | 'events' | 'activity' | 'sprints';

export function BoardPanel({ tabId, tabName, onOpenSprint }: {
  tabId: string;
  tabName: string;
  /** Filter the work view to a sprint, or to the backlog (`null`) — the one thing the sprints
   *  page ever did to a view. */
  onOpenSprint?: (id: string | null) => void;
}) {
  // Sprints moved in here from the view switcher (§N2.3): its main action was always to set a
  // filter on another view, which makes it a management page, not a view of the tasks.
  //
  // The Sprints tab is the one with a URL (/b/:id/sprints), so it is read from the store that the
  // URL syncs to rather than held here. It used to be only the initial value of local state: a
  // link to /sprints with the panel already open did nothing, and clicking the tab never changed
  // the URL, so a refresh after leaving it landed back on it.
  const boardPanel = useStore((s) => s.boardPanel);
  const setBoardPanel = useStore((s) => s.setBoardPanel);
  const [other, setOther] = useState<Exclude<PanelTab, 'sprints'>>('members');
  const tab: PanelTab = boardPanel === 'sprints' ? 'sprints' : other;
  const setTab = (t: PanelTab): void => {
    if (t !== 'sprints') setOther(t);
    setBoardPanel(t === 'sprints' ? 'sprints' : null);
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  return (
    <aside className="board-panel">
      <div className="board-panel-tabs">
        <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>Members</button>
        <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Events</button>
        <button className={tab === 'sprints' ? 'on' : ''} onClick={() => setTab('sprints')}>Sprints</button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>

      <div className="board-panel-body">
        {tab === 'members' && <SharePanel embedded tabId={tabId} tabName={tabName} onClose={() => {}} />}
        {tab === 'events' && <EventsPanel embedded tabId={tabId} tabName={tabName} onClose={() => {}} />}
        {tab === 'sprints' && <SprintsPage tabId={tabId} onOpenSprint={(id) => onOpenSprint?.(id)} />}
        {tab === 'activity' && (
          <div className="activity-tab">
            <BoardActivity tabId={tabId} />
            <div className="activity-actions">
              <button className="btn ghost" onClick={() => setHistoryOpen(true)}>Board history</button>
              <button className="btn ghost" onClick={() => setTrashOpen(true)}>Trash</button>
            </div>
          </div>
        )}
      </div>

      {historyOpen && <ActivityDrawer kind="tab" id={tabId} boardId={tabId} title={tabName} onClose={() => setHistoryOpen(false)} />}
      {trashOpen && <TrashPanel tabId={tabId} tabName={tabName} onClose={() => setTrashOpen(false)} />}
    </aside>
  );
}
