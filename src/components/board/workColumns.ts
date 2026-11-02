// The table's columns (NOTES_SPLIT_PLAN §N2, CUSTOM_FIELDS_PLAN P4).
//
// Which columns a board's table shows, and in what order, is the board's `tableColumns` list
// (shared/fields.ts), the same for everyone on it. Select, Title and the open button are always
// there and are not in the list. `field` is what a click on a built-in cell scopes the shared
// action menu to — which is what makes a cell behave like an editor without one existing. A custom
// field's cell is read-only here; its value is edited on the task page.

import type { FocusField } from '../../tasks/actions';
import type { SortKey } from './workView';
import { columnFieldKey, type BoardField, type BuiltinColumn } from '../../../shared/fields';

export interface ColumnDef {
  /** The id in the board's `tableColumns`: a built-in, or `f:<field key>`. */
  id: string;
  label: string;
  /** Null for a column the table does not sort by (Parent). */
  sortKey: SortKey | null;
  field?: FocusField;
  /** Set for a custom field's column. */
  boardField?: BoardField;
  /** Its grid track, and the narrowest that track gets. */
  track: string;
  min: number;
}

const BUILTIN: Record<BuiltinColumn, Omit<ColumnDef, 'id'>> = {
  status: { label: 'Status', sortKey: 'status', field: 'status', track: '96px', min: 96 },
  assignee: { label: 'Assignee', sortKey: 'assignee', field: 'assignee', track: '92px', min: 92 },
  due: { label: 'Due', sortKey: 'due', field: 'due', track: '74px', min: 74 },
  priority: { label: 'Pri', sortKey: 'priority', field: 'priority', track: '40px', min: 40 },
  sprint: { label: 'Sprint', sortKey: 'sprint', field: 'sprint', track: '78px', min: 78 },
  parent: { label: 'Parent', sortKey: null, track: 'minmax(80px, 1.4fr)', min: 80 },
};

/** What each built-in column is called in settings, where "Pri" would be cryptic. */
export const BUILTIN_COLUMN_LABEL: Record<BuiltinColumn, string> = {
  status: 'Status', assignee: 'Assignee', due: 'Due date', priority: 'Priority', sprint: 'Sprint', parent: 'Parent task',
};

/** The board's columns, in its order. A field column is a fixed width: a value is a short thing. */
export function buildColumns(ids: readonly string[], fields: readonly BoardField[]): ColumnDef[] {
  return ids.flatMap((id): ColumnDef[] => {
    const key = columnFieldKey(id);
    if (key === null) return id in BUILTIN ? [{ id, ...BUILTIN[id as BuiltinColumn] }] : [];
    const f = fields.find((x) => x.key === key);
    if (!f) return [];
    const width = f.type === 'number' ? 90 : 150;
    return [{ id, label: f.label, sortKey: `f:${f.key}`, boardField: f, track: `${width}px`, min: width }];
  });
}

/**
 * Where each cell sits in the cursor's track: select, title, the board's columns, then the open
 * button. Both the markup and the keyboard read the index from here, so they agree.
 */
export const COL = { select: 0, title: 1, first: 2 } as const;

/** The open button's index, which is also the last one the cursor can reach. */
export const openCol = (columns: readonly ColumnDef[]): number => COL.first + columns.length;

/** The column a cursor index refers to, or undefined for select/title/open. */
export const columnAt = (columns: readonly ColumnDef[], col: number): ColumnDef | undefined =>
  col >= COL.first ? columns[col - COL.first] : undefined;

/**
 * The grid of a row: `wide` with every column, `narrow` for a window too small for Parent (index.css
 * hides its cells at that width), and `min`, the width below which the table scrolls sideways
 * rather than squeezing.
 */
export function gridOf(columns: readonly ColumnDef[]): { wide: string; narrow: string; min: number } {
  const tracks = (cols: readonly ColumnDef[]) => cols.map((c) => c.track).join(' ');
  const noParent = columns.filter((c) => c.id !== 'parent');
  const gaps = 8 * (columns.length + 2);
  return {
    wide: `24px minmax(200px, 4fr) ${tracks(columns)} 28px`,
    narrow: `24px minmax(180px, 4fr) ${tracks(noParent)} 28px`,
    min: 24 + 200 + 28 + gaps + noParent.reduce((n, c) => n + c.min, 0),
  };
}
