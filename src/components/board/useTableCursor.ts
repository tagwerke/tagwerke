// Moving through the table the way you move through a document.
//
// The model, and why it is this one: the cursor is on a ROW, with a column focused inside it. Up
// and down move rows; left and right move across that row's cells. A pure cell grid would be
// spreadsheet-correct and wrong here — you would arrow through six cells to get down one line, and
// the common motion by far is down the list, not across a record.
//
// The cursor visits EVERY column, select and parent and open included. A cell you can read is a
// cell you can land on; skipping the ones with nothing to set would make left and right jump
// unpredictably.
//
// There are no letter shortcuts. There were — `s a d p r` jumped to a field — and they went with
// TABLE_EDITING_PLAN §T2.1: once the arrows move between cells, a second invisible way to reach
// the same cell is a surface nobody finds, and it was the only thing standing between the title
// column and being able to just type into it.
//
// The last row of the table is the add line, and the cursor falls into it. That is what makes this
// feel like a document rather than a grid: you arrow to the bottom, keep going, and you are typing
// the next task.
//
// One deliberate accessibility trade. In an ARIA grid, Tab exits the widget and arrows move within
// it; here Tab nests, because nesting by Tab is the gesture people brought from the document.
// Escape releases the cursor, at which point Tab behaves normally again — so the keyboard is never
// a trap, it just has a mode.

import { useCallback, useEffect, useRef, useState } from 'react';
import { COL, COL_LAST } from './workColumns';
import type { ID } from '../../types';

/** `'add'` is the quick-add line: a real stop on the same track, not a special case bolted on. */
export type CursorRow = ID | 'add';

export interface TableCursor {
  row: CursorRow;
  col: number;
}

export interface TableCursorHandlers {
  /** Enter on a field cell. */
  openCell(taskId: ID, col: number): void;
  /** Enter on the title, or the first character of a typed rename. */
  renameStart(taskId: ID, seed?: string): void;
  openTask(taskId: ID): void;
  toggleSelect(taskId: ID): void;
  nest(taskId: ID): void;
  unnest(taskId: ID): void;
  remove(taskId: ID): void;
  /** Put the caret in the quick-add line when the cursor lands on it. */
  focusAdd(): void;
}

/** A key that should start typing into a title rather than doing anything else. */
function isTypingKey(e: React.KeyboardEvent): boolean {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
}

export function useTableCursor(
  rowIds: ID[],
  handlers: TableCursorHandlers,
  enabled: boolean,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [raw, setCursor] = useState<TableCursor | null>(null);
  // Handlers are rebuilt every render by their callers; reading them through a ref keeps the
  // keydown callback stable so the container is not re-bound on every keystroke.
  const h = useRef(handlers);
  useEffect(() => { h.current = handlers; });

  // A cursor on a row that filtering, collapsing or a delete just took away is a cursor on
  // nothing, and the next arrow key would jump somewhere arbitrary. Derived rather than corrected
  // in an effect, so there is never a render where the cursor points at a row that is not there.
  const cursor = raw && (raw.row === 'add' || rowIds.includes(raw.row)) ? raw : null;

  // Keep the cursor on screen, and only just — `nearest` scrolls the minimum, so arrowing down a
  // long list does not yank the viewport around on every step.
  useEffect(() => {
    if (!cursor) return;
    const sel = cursor.row === 'add' ? '[data-add-row]' : `[data-row="${CSS.escape(cursor.row)}"]`;
    containerRef.current?.querySelector(sel)?.scrollIntoView({ block: 'nearest' });
    // Call it, do not return it: focusAdd answers with a boolean, and an effect that returns a
    // non-function makes React treat it as the cleanup. It only bites on the way OUT of the add
    // line, when React calls that value and `true` is not a function — taking the tree with it.
    if (cursor.row === 'add') { h.current.focusAdd(); return; }

    // A visible cursor with the keyboard somewhere else is the "frozen" state: the cursor is
    // clearly on a row and nothing responds. It happens whenever something inside the table
    // unmounts under the caret — a rename closing, a row deleted, a menu going away — and focus
    // falls to <body>. Only claimed when focus is not already inside, so an open rename input and
    // a focused cell both keep it.
    // The add line's input counts as somewhere else, even though it sits inside the table: on the
    // way out of it the cursor is on a row while the caret is still in the box, so what you type
    // is filed as a new task instead of renaming the row you are looking at.
    const active = document.activeElement;
    const inAddLine = active instanceof Element && !!active.closest('.quick-add');
    const root = containerRef.current;
    if (root && (inAddLine || !root.contains(active))) root.focus({ preventScroll: true });
  }, [cursor, containerRef]);

  const move = useCallback((delta: number) => {
    setCursor((cur) => {
      // No cursor yet: the first arrow enters the list at whichever end you came from.
      if (!cur) return { row: rowIds[delta > 0 ? 0 : rowIds.length - 1] ?? 'add', col: COL.title };
      const track: CursorRow[] = [...rowIds, 'add'];
      const i = track.indexOf(cur.row);
      const next = track[Math.min(track.length - 1, Math.max(0, i + delta))];
      return next === undefined ? cur : { row: next, col: cur.col };
    });
  }, [rowIds]);

  const onKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!enabled) return false;
    const cur = cursor;

    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
    if (!cur) return false;

    if (e.key === 'Escape') { e.preventDefault(); setCursor(null); return true; }

    // Everything below acts on a task, so the add line ignores it and lets its own input have the key.
    if (cur.row === 'add') return false;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setCursor({ ...cur, col: Math.min(COL_LAST, cur.col + 1) });
      return true;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setCursor({ ...cur, col: Math.max(0, cur.col - 1) });
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) h.current.unnest(cur.row);
      else h.current.nest(cur.row);
      return true;
    }
    if (e.key === 'Delete') { e.preventDefault(); h.current.remove(cur.row); return true; }

    if (e.key === 'Enter' || (e.key === ' ' && cur.col === COL.select)) {
      e.preventDefault();
      if (cur.col === COL.select) h.current.toggleSelect(cur.row);
      else if (cur.col === COL.title) h.current.renameStart(cur.row);
      else if (cur.col === COL.open) h.current.openTask(cur.row);
      else if (cur.col < COL.parent) h.current.openCell(cur.row, cur.col);
      // Parent has nothing to open: it is text, and `↗` is the only way out of a row.
      return true;
    }

    // Typing on a title starts the rename with what you typed, the way a document line would.
    if (cur.col === COL.title && isTypingKey(e)) {
      e.preventDefault();
      h.current.renameStart(cur.row, e.key);
      return true;
    }
    return false;
  }, [cursor, enabled, move]);

  return { cursor, setCursor, onKeyDown, moveRow: move };
}
