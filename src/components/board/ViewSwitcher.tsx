// Table · Kanban · Notes.
//
// Lives on the RIGHT of a board's toolbar, opposite the controls that shape what you are looking
// at. Which view you are in and how that view is arranged are different questions, and putting
// them at opposite ends stops the toolbar reading as one undifferentiated row of chips.
//
// Rendered by each view's own toolbar rather than by the board shell, so a view owns its whole bar
// — but from one component, so the switcher itself cannot drift between them.

import { BOARD_VIEWS, type BoardView } from '../../types';

const LABEL: Record<BoardView, string> = { table: 'Table', kanban: 'Kanban', notes: 'Notes' };

export function ViewSwitcher({ view, onChange }: { view: BoardView; onChange: (v: BoardView) => void }) {
  return (
    <div className="seg board-views" role="tablist" aria-label="Board view">
      {BOARD_VIEWS.map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          className={view === v ? 'on' : ''}
          onClick={() => onChange(v)}
        >
          {LABEL[v]}
        </button>
      ))}
    </div>
  );
}
