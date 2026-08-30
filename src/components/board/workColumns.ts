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
