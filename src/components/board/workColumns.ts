// The table's columns (NOTES_SPLIT_PLAN §N2).
//
// `key` doubles as the sort key, and `field` is what a click on that cell scopes the shared action
// menu to — which is what makes a cell behave like an editor without one existing.

import type { FocusField } from '../../tasks/actions';
import type { SortKey } from './workView';

export interface ColumnDef {
  key: SortKey;
  label: string;
  field?: FocusField;
}

export const COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', field: 'status' },
  { key: 'assignee', label: 'Assignee', field: 'assignee' },
  { key: 'due', label: 'Due', field: 'due' },
  { key: 'priority', label: 'Pri', field: 'priority' },
  { key: 'sprint', label: 'Sprint', field: 'sprint' },
];

/**
 * Where each cell sits in the cursor's track. The table has one more column than it has fields —
 * select at the front, then the title, the fields, the parent, and the open button — and both the
 * markup and the keyboard have to agree about which index is which, so they agree here.
 */
export const COL = {
  select: 0,
  title: 1,
  /** Fields occupy `fieldFirst` .. `fieldFirst + COLUMNS.length - 1`. */
  fieldFirst: 2,
  parent: 2 + COLUMNS.length,
  open: 3 + COLUMNS.length,
} as const;

/** Highest reachable column index. */
export const COL_LAST = COL.open;

/** The field definition a cursor column refers to, or undefined for select/title/parent/open. */
export function columnAt(col: number): ColumnDef | undefined {
  return col >= COL.fieldFirst && col < COL.parent ? COLUMNS[col - COL.fieldFirst] : undefined;
}
