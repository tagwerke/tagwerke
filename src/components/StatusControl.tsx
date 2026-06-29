// The task status control: a one-click done toggle + a caret that opens the 5-status
// menu. Extracted from the editor's TaskItemView so the Planner mini-board reuses the
// exact same affordance (same classes/markup → same styling). `disabled` renders a
// read-only indicator (teammates' lanes in the Planner).

import { useState, useEffect, useRef } from 'react';
import type { TaskStatus } from '../types';

export const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

interface Props {
  status: TaskStatus;
  onToggle: () => void;
  onPick: (s: TaskStatus) => void;
  accentColor?: string;
  disabled?: boolean;
}

export function StatusControl({ status, onToggle, onPick, accentColor, disabled }: Props) {
  const done = status === 'done';
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
        className={`task-indicator status-${status}`}
        onClick={onToggle}
        disabled={disabled}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        style={accentColor ? ({ '--accent': accentColor } as React.CSSProperties) : undefined}
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
          {STATUS_ORDER.map((s) => (
            <li
              key={s}
              role="option"
              aria-selected={s === status}
              className={`status-option status-${s} ${s === status ? 'is-selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s);
                setMenuOpen(false);
              }}
            >
              <span className="status-swatch" />
              {STATUS_LABEL[s]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
