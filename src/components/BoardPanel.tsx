// The open board's companion rail: one panel, single-purpose tabs. Replaces the old
// separate Share / Schedule modals. Each tab embeds the existing panel body:
//   Members  — roster, roles, invite, board rules  (MembersPanel)
//   Events   — agenda, location, RSVP              (EventsPanel)
//   States   — the board's task states            (BoardStatesPanel)
//   Activity — presence + board history + trash    (BoardActivity + ActivityDrawer/TrashPanel)
// On desktop it's a persistent right rail; on mobile TabView mounts it inside a Sheet.

import { useState } from 'react';
import { useStore } from '../store';
import { MembersPanel } from './MembersPanel';
import { EventsPanel } from './EventsPanel';
import { BoardActivity } from './BoardActivity';
import { ActivityDrawer } from './ActivityDrawer';
import { TrashPanel } from './TrashPanel';
import { SprintsPage } from './SprintsPage';
import { BoardStatesPanel } from './states/BoardStatesPanel';
import { Tabs } from './common/Segmented';

type PanelTab = 'members' | 'events' | 'activity' | 'sprints' | 'states';

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
      <Tabs
        fill
        className="board-panel-tabs"
        label="Board panel"
        options={[
          { value: 'members', label: 'Members' },
          { value: 'events', label: 'Events' },
          { value: 'sprints', label: 'Sprints' },
          { value: 'states', label: 'States' },
          { value: 'activity', label: 'Activity' },
        ]}
        value={tab}
        onChange={setTab}
      />

      <div className="board-panel-body">
        {tab === 'members' && <MembersPanel tabId={tabId} tabName={tabName} />}
        {tab === 'events' && <EventsPanel tabId={tabId} />}
        {tab === 'sprints' && <SprintsPage tabId={tabId} onOpenSprint={(id) => onOpenSprint?.(id)} />}
        {tab === 'states' && <BoardStatesPanel tabId={tabId} />}
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
