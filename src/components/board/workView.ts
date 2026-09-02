// Shared vocabulary for the board's work view (NOTES_SPLIT_PLAN §N2).
//
// Table and Kanban are ONE view with two layouts, not two views: same tasks, same grouping, same
// order, same actions — only the arrangement differs. Everything both layouts need to agree on
// lives here so neither can drift.

import { STATUS_LABEL, STATUS_ORDER } from '../StatusControl';
import { compareRank } from '../../../shared/rank';
import type { ID, Member, Sprint, Task, TaskStatus } from '../../types';

export type WorkLayout = 'table' | 'board';
export type Grouping = 'status' | 'assignee' | 'sprint' | 'none';
export type SortKey = 'rank' | 'title' | 'status' | 'assignee' | 'due' | 'priority' | 'sprint';
export type SortDir = 'asc' | 'desc';
export interface Sort { key: SortKey; dir: SortDir }

export interface Group {
  key: string;
  label: string;
  /** A status group's dot class. */
  swatch?: string;
  tasks: Task[];
}

export const GROUPINGS: { key: Grouping; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'sprint', label: 'Sprint' },
  // Named for what it IS rather than what it lacks: with no grouping and the board's own rank
  // order, the rows are a contiguous outline and can be indented truthfully (§N2.5).
  { key: 'none', label: 'Outline' },
];

/** The bucket a task belongs to under `grouping`. `null` means "the unset bucket". */
export function bucketOf(task: Task, grouping: Grouping): string | null {
  switch (grouping) {
    case 'status': return task.status ?? 'todo';
    case 'assignee': return task.assigneeId ?? null;
    case 'sprint': return task.sprintId ?? null;
    case 'none': return 'all';
  }
}

/**
 * Split tasks into groups, keeping each group's internal order exactly as it arrived.
 *
 * `order` is the board's outline order (SUBTASKS_PLAN D4) — the one true order every view reads —
 * so bucketing preserves it and a family stays adjacent inside its group. Empty groups survive
 * because the board layout needs a column for a status nobody is in.
 */
export function groupTasks(
  tasks: Task[],
  grouping: Grouping,
  members: Member[],
  sprints: Sprint[],
): Group[] {
  const buckets = new Map<string, Task[]>();
  const put = (key: string, t: Task) => {
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  };
  for (const t of tasks) put(bucketOf(t, grouping) ?? '~none', t);

  if (grouping === 'none') return [{ key: 'all', label: 'Outline', tasks: buckets.get('all') ?? [] }];

  if (grouping === 'status') {
    return STATUS_ORDER.map((s) => ({
      key: s,
      label: STATUS_LABEL[s],
      swatch: `status-${s}`,
      tasks: buckets.get(s) ?? [],
    }));
  }

  if (grouping === 'assignee') {
    return [
      ...members.map((m) => ({ key: m.id, label: m.name, tasks: buckets.get(m.id) ?? [] })),
      { key: '~none', label: 'Unassigned', tasks: buckets.get('~none') ?? [] },
    ];
  }

  return [
    ...sprints.map((s) => ({ key: s.id, label: s.label, tasks: buckets.get(s.id) ?? [] })),
    { key: '~none', label: 'Backlog', tasks: buckets.get('~none') ?? [] },
  ];
}

/** Display value for a sort comparison. Unset always sorts last, whichever direction. */
function sortValue(t: Task, key: SortKey, names: Map<ID, string>, sprintNames: Map<ID, string>): string | number | null {
  switch (key) {
    case 'title': return t.text.trim().toLowerCase() || null;
    case 'status': return STATUS_ORDER.indexOf(t.status ?? 'todo');
    case 'assignee': return t.assigneeId ? (names.get(t.assigneeId) ?? '').toLowerCase() : null;
    case 'due': return t.date ?? null;
    case 'priority': return t.priority ?? null;
    case 'sprint': return t.sprintId ? (sprintNames.get(t.sprintId) ?? '') : null;
    case 'rank': return null;
  }
}

/**
 * Sort a group's tasks. `rank` returns them untouched — they arrived in outline order, which IS
 * the rank order, and re-deriving it would break the tree (a sub-task's place depends on its
 * ancestors, not on its own key). Every other sort falls back to that same order for ties, so the
 * result is stable and a re-sort never shuffles equal rows.
 */
export function sortTasks(
  tasks: Task[],
  sort: Sort,
  names: Map<ID, string>,
  sprintNames: Map<ID, string>,
): Task[] {
  if (sort.key === 'rank') return tasks;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const av = sortValue(a, sort.key, names, sprintNames);
    const bv = sortValue(b, sort.key, names, sprintNames);
    if (av === null && bv === null) return compareRank(a, b);
    if (av === null) return 1; // unset last, regardless of direction
    if (bv === null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return compareRank(a, b);
  });
}

/** The status a card dropped on this group should take, when grouping by status. */
export function statusOfGroup(key: string): TaskStatus | null {
  return (STATUS_ORDER as string[]).includes(key) ? (key as TaskStatus) : null;
}
