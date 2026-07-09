// The open board's companion rail: one panel, single-purpose tabs. Replaces the old
// separate Share / Schedule modals. Each tab embeds the existing panel body:
//   Members  — roster, roles, invite, board rules  (SharePanel, embedded)
//   Events   — agenda, location, RSVP              (EventsPanel, embedded)
//   Activity — presence + board history + trash    (BoardActivity + HistoryDrawer/TrashPanel)
// On desktop it's a persistent right rail; on mobile TabView mounts it inside a Sheet.

import { useState } from 'react';
import { SharePanel } from './SharePanel';
import { EventsPanel } from './EventsPanel';
import { BoardActivity } from './BoardActivity';
import { HistoryDrawer } from './HistoryDrawer';
import { TrashPanel } from './TrashPanel';

type PanelTab = 'members' | 'events' | 'activity';

export function BoardPanel({ tabId, tabName }: { tabId: string; tabName: string }) {
  const [tab, setTab] = useState<PanelTab>('members');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  return (
    <aside className="board-panel">
      <div className="board-panel-tabs">
        <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>Members</button>
        <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Events</button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>

      <div className="board-panel-body">
        {tab === 'members' && <SharePanel embedded tabId={tabId} tabName={tabName} onClose={() => {}} />}
        {tab === 'events' && <EventsPanel embedded tabId={tabId} tabName={tabName} onClose={() => {}} />}
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

      {historyOpen && <HistoryDrawer kind="tab" id={tabId} boardId={tabId} title={tabName} onClose={() => setHistoryOpen(false)} />}
      {trashOpen && <TrashPanel tabId={tabId} tabName={tabName} onClose={() => setTrashOpen(false)} />}
    </aside>
  );
}
