// The one menu (NOTES_SPLIT_PLAN §N3, §I.2, §I.3).
//
// Same component from a right-click on a row, the `⋯` on hover, the `.` key, and a click on a
// table cell. The cell case passes `focusField`, which opens straight into that field's choices
// instead of the top-level list — so a table cell reads as an editor without there being a
// separate cell editor. Everything it can do comes from `tasks/actions.ts`; this file knows how to
// draw a list and drive a keyboard, and nothing about what a task is.

import { useEffect, useMemo, useRef, useState } from 'react';
import { actionForField, actionsFor, type ChoiceOption, type FocusField, type TaskAction } from '../../tasks/actions';
import type { ID } from '../../types';

export function TaskActionMenu({ ids, tabId, focusField, x, y, onClose }: {
  ids: ID[];
  tabId: ID;
  /** Open directly into this field's choices — a table cell click. */
  focusField?: FocusField;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ctx = useMemo(() => ({ ids, tabId }), [ids, tabId]);
  const actions = useMemo(() => actionsFor(ctx), [ctx]);
  // Which action's choices are showing. Seeded from focusField, but only if that action is
  // actually available here — a cell for a field the caller may not edit falls back to the list.
  const [openAction, setOpenAction] = useState<TaskAction | null>(() => {
    if (!focusField) return null;
    const a = actionForField(focusField);
    return a && actions.includes(a) ? a : null;
  });
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const choices = useMemo(() => (openAction?.options ? openAction.options(ctx) : null), [openAction, ctx]);

  // What the arrow keys are moving over right now: either the choices or the action list.
  const rows: (TaskAction | ChoiceOption)[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: (TaskAction | ChoiceOption)[] = choices ?? actions;
    return q ? list.filter((r) => r.label.toLowerCase().includes(q)) : list;
  }, [choices, actions, query]);

  /** Any change to what is listed puts the highlight back at the top. Done at the point of change
   *  rather than in an effect, so the list and its highlight are never briefly out of step. */
  const showActions = (): void => { setOpenAction(null); setQuery(''); setHighlight(0); };
  const showChoices = (a: TaskAction): void => { setOpenAction(a); setQuery(''); setHighlight(0); };
  const typeInto = (ch: string): void => { setQuery((q) => q + ch); setHighlight(0); };

  // Focus the menu itself so the keyboard reaches it, and hand focus back on the way out — a menu
  // that drops you nowhere is unusable without a mouse (§A).
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    rootRef.current?.focus();
    return () => returnTo?.focus?.();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const choose = (i: number): void => {
    const row = rows[i];
    if (!row) return;
    if (choices) {
      (row as ChoiceOption).run();
      return onClose();
    }
    const action = row as TaskAction;
    if (action.options) return showChoices(action);
    action.run?.(ctx);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); return setHighlight((h) => Math.min(rows.length - 1, h + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); return setHighlight((h) => Math.max(0, h - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); return choose(highlight); }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Escape backs out one level before it closes, so a mis-click on a cell is one key to undo.
      if (openAction && !focusField) return showActions();
      return onClose();
    }
    if (e.key === 'Backspace' && !query && openAction && !focusField) {
      e.preventDefault();
      return showActions();
    }
    if (e.key === 'Backspace' && query) {
      e.preventDefault();
      setQuery((q) => q.slice(0, -1));
      return setHighlight(0);
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      typeInto(e.key);
    }
  };

  const header = openAction
    ? openAction.label
    : ids.length === 1 ? 'Task actions' : `${ids.length} tasks`;

  return (
    <div
      ref={rootRef}
      className="task-menu"
      role="menu"
      aria-label={header}
      tabIndex={-1}
      style={{ position: 'fixed', top: y, left: x, zIndex: 60 }}
      onKeyDown={onKeyDown}
    >
      <div className="task-menu-head">
        {openAction && !focusField && (
          <button type="button" className="task-menu-back" aria-label="Back to all actions" onClick={showActions}>
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
              <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <span>{header}</span>
        {query && <span className="task-menu-query">{query}</span>}
      </div>

      <ul className="task-menu-list">
        {rows.length === 0 && <li className="task-menu-empty muted">Nothing matches</li>}
        {rows.map((row, i) => {
          const isChoice = !!choices;
          const choice = isChoice ? (row as ChoiceOption) : null;
          const action = isChoice ? null : (row as TaskAction);
          return (
            <li key={isChoice ? choice!.key : action!.id}>
              <button
                type="button"
                role="menuitem"
                className={`task-menu-item ${i === highlight ? 'is-active' : ''} ${action?.danger ? 'is-danger' : ''} ${choice?.selected ? 'is-selected' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(i); }}
              >
                {choice?.swatch && <span className={`task-menu-swatch ${choice.swatch}`} />}
                <span className="task-menu-label">{row.label}</span>
                {choice?.hint && <span className="task-menu-hint">{choice.hint}</span>}
                {action?.key && <span className="task-menu-key">{action.key}</span>}
                {action?.options && (
                  <svg className="task-menu-more" viewBox="0 0 16 16" width="10" height="10" aria-hidden>
                    <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {choice?.selected && (
                  <svg className="task-menu-tick" viewBox="0 0 16 16" width="11" height="11" aria-hidden>
                    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
