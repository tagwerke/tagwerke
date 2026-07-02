// Human-readable labels for audited field keys, shared by the per-object History drawer
// and the admin Audit view so "reviewerId" never leaks to a user as-is.

const FIELD_LABELS: Record<string, string> = {
  text: 'text',
  status: 'status',
  assigneeId: 'assignee',
  reviewerId: 'reviewer',
  approvedBy: 'approver',
  date: 'due',
  priority: 'priority',
  homeTabId: 'board',
  tabId: 'board',
  docJSON: 'document',
  name: 'name',
  location: 'location',
  start: 'start',
  end: 'end',
  label: 'label',
  settings: 'settings',
};

/** Which audited fields hold a user id (so a value can be resolved to a person). */
export const USER_FIELDS = new Set(['assigneeId', 'reviewerId', 'approvedBy']);

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}
