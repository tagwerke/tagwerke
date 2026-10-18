// Table · Notes · Files · Secrets.
//
// Lives on the RIGHT of a board's toolbar, opposite the controls that shape what you are looking
// at. Which view you are in and how that view is arranged are different questions, and putting
// them at opposite ends stops the toolbar reading as one undifferentiated row of chips.
//
// Rendered by each view's own toolbar rather than by the board shell, so a view owns its whole bar
// — but from one component, so the switcher itself cannot drift between them.

import { useStore } from '../../store';
import { BOARD_VIEWS, type BoardView } from '../../types';
import { Segmented } from '../common/Segmented';

const LABEL: Record<BoardView, string> = { table: 'Table', notes: 'Notes', files: 'Files', secrets: 'Secrets' };

export function ViewSwitcher({ view, onChange }: { view: BoardView; onChange: (v: BoardView) => void }) {
  // Secrets is board-admin only. Hidden, not disabled: to anyone else, a board's secrets don't exist.
  const isAdmin = useStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.role === 'admin' : false));
  const views = isAdmin ? BOARD_VIEWS : BOARD_VIEWS.filter((v) => v !== 'secrets');
  return (
    <Segmented
      className="board-views"
      label="Board view"
      options={views.map((v) => ({ value: v, label: LABEL[v] }))}
      value={view}
      onChange={onChange}
    />
  );
}
