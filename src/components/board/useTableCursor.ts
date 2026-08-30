// Moving through the table the way you move through a document.
//
// The model, and why it is this one: the cursor is on a ROW, with a column focused inside it. Up
// and down move rows; left and right move across that row's cells. A pure cell grid would be
// spreadsheet-correct and wrong here — you would arrow through six cells to get down one line, and
// the common motion by far is down the list, not across a record.
//
// The last row of the table is the add line, and the cursor falls into it. That is what makes this
// feel like a document rather than a grid: you arrow to the bottom, keep going, and you are typing
// the next task. Enter there adds it and leaves you in place for another.
//
// One deliberate accessibility trade. In an ARIA grid, Tab exits the widget and arrows move within
// it; here Tab nests, because nesting by Tab is the gesture people brought from the document and
// the whole point of this pass is that they keep it. Escape releases the cursor, at which point Tab
// behaves normally again — so the keyboard is never a trap, it just has a mode.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID } from '../../types';

/** `'add'` is the quick-add line: a real stop on the same track, not a special case bolted on. */
export type CursorRow = ID | 'add';

export interface TableCursor {
  row: CursorRow;
  /** 0 is the title; 1..colCount are the field cells, left to right. */
  col: number;
}

export interface TableCursorHandlers {
  /** Enter on a field cell, or one of the letter keys. */
  openCell(taskId: ID, col: number): void;
  /** Enter on the title. */
  renameStart(taskId: ID): void;
  nest(taskId: ID): void;
  unnest(taskId: ID): void;
  remove(taskId: ID): void;
  toggleDone(taskId: ID): void;
  /** Put the caret in the quick-add line when the cursor lands on it. */
  focusAdd(): void;
}

/** Letter keys that jump straight to a field, by column index (§I.2). */
const LETTER_TO_COL: Record<string, number> = { s: 1, a: 2, d: 3, p: 4, r: 5 };

export function useTableCursor(
  rowIds: ID[],
  colCount: number,
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
    if (cursor.row === 'add') h.current.focusAdd();
  }, [cursor, containerRef]);

  const move = useCallback((delta: number) => {
    setCursor((cur) => {
      // No cursor yet: the first arrow enters the list at whichever end you came from.
      if (!cur) return { row: rowIds[delta > 0 ? 0 : rowIds.length - 1] ?? 'add', col: 0 };
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
      setCursor({ ...cur, col: Math.min(colCount, cur.col + 1) });
      return true;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setCursor({ ...cur, col: Math.max(0, cur.col - 1) });
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (cur.col === 0) h.current.renameStart(cur.row);
      else h.current.openCell(cur.row, cur.col);
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) h.current.unnest(cur.row);
      else h.current.nest(cur.row);
      return true;
    }
    if (e.key === ' ') { e.preventDefault(); h.current.toggleDone(cur.row); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); h.current.remove(cur.row); return true; }

    const col = LETTER_TO_COL[e.key.toLowerCase()];
    if (col !== undefined && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setCursor({ ...cur, col });
      h.current.openCell(cur.row, col);
      return true;
    }
    return false;
  }, [cursor, enabled, colCount, move]);

  return { cursor, setCursor, onKeyDown };
}
