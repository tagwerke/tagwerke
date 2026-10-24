// The task status control: a one-click done toggle + a caret that opens the status
// menu. Extracted from the editor's TaskItemView so the Planner mini-board reuses the
// exact same affordance (same classes/markup → same styling). `disabled` renders a
// read-only indicator (teammates' lanes in the Planner).
//
// The board's own states (BOARD_STATES_PLAN): the menu lists the visible ones, and the indicator
// takes its shape from the state's category and its color from the state.

import { useState, useEffect, useRef } from 'react';
import type { ID } from '../types';
import { stateIn, stateStyle, useBoardStates } from '../tasks/states';
import { visible } from '../../shared/status';

interface Props {
  tabId: ID;
  status: string;
  onToggle: () => void;
  onPick: (s: string) => void;
  disabled?: boolean;
}

export function StatusControl({ tabId, status, onToggle, onPick, disabled }: Props) {
  const states = useBoardStates(tabId);
  const state = stateIn(states, status);
  const done = state.category === 'done';
  // A hidden state stays valid on the tasks that have it, so show it there (selected) even though
  // it isn't offered for anything else.
  const options = visible(states);
  if (!options.some((s) => s.key === status)) options.push(state);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <div className="task-status" contentEditable={false} ref={rootRef}>
      <button
        type="button"
        className={`task-indicator cat-${state.category}`}
        onClick={onToggle}
        disabled={disabled}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        title={state.label}
        style={stateStyle(state)}
      >
        <span className="dot" />
        <svg viewBox="0 0 16 16" className="check" aria-hidden>
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {!disabled && (
        <button
          type="button"
          className="status-caret"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Set status"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
        >
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden>
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {menuOpen && (
        <ul className="status-menu" role="listbox">
          {options.map((s) => (
            <li
              key={s.key}
              role="option"
              aria-selected={s.key === status}
              className={`status-option ${s.key === status ? 'is-selected' : ''}`}
              title={s.description ?? undefined}
              style={stateStyle(s)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s.key);
                setMenuOpen(false);
              }}
            >
              <span className="status-swatch" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
