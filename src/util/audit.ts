// Human-readable labels for audited field keys, shared by the per-object History drawer
// and the admin Audit view so "reviewerId" never leaks to a user as-is.

import { DEFAULT_LABEL } from '../../shared/status';

const FIELD_LABELS: Record<string, string> = {
  text: 'text',
  status: 'status',
  assigneeId: 'assignee',
  reviewerId: 'reviewer', // legacy: the field is gone, but old history rows still name it
  date: 'due',
  priority: 'priority',
  homeTabId: 'board',
  parentTaskId: 'parent',
  sprintId: 'sprint',
  tabId: 'board',
  docJSON: 'document',
  name: 'name',
  location: 'location',
  start: 'start',
  end: 'end',
  label: 'label',
  settings: 'settings',
  // A board's task states (board_state_change rows).
  category: 'category',
  color: 'color',
  description: 'description',
  hidden: 'hidden',
  order: 'order',
};

/** Which audited fields hold a user id (so a value can be resolved to a person). */
export const USER_FIELDS = new Set(['assigneeId', 'reviewerId']);

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** One side of a status change as people read it (BOARD_STATES_PLAN D10): the label stored with
 *  the change, i.e. what the state was called THEN — never the board's current label. Entries from
 *  before per-board states carry only a key, and those keys always had the default labels. */
export function statusLabelAt(c: { from: unknown; to: unknown; fromLabel?: string; toLabel?: string }, side: 'from' | 'to'): string | null {
  const key = c[side];
  if (key == null || key === '') return null;
  return (side === 'from' ? c.fromLabel : c.toLabel) ?? DEFAULT_LABEL[String(key)] ?? String(key);
}
