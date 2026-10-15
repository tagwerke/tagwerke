// What a board's work view is filtered to (BOARD_FILTERS_PLAN §2).
//
// Pure functions plus one small hook. The filters are applied to the board's outline BEFORE
// grouping and sorting, so every grouping sees the same tasks, and the rules that say
// what a new task starts as live next to the rules that say what is shown — a task added under a
// filter should be one the filter would show.

import { useCallback, useEffect, useState } from 'react';
import { ancestorsOf } from '../../store';
import type { DraftFields } from '../../tasks/createTask';
import type { ID, Task, TaskStatus } from '../../types';

/** Stand-ins for "no sprint" / "no assignee" inside a filter list. */
export const BACKLOG = 'backlog';
export const UNASSIGNED = 'none';
/** "No priority" inside a priority filter; the others are '1' | '2' | '3'. */
export const NO_PRIORITY = 'none';

export interface WorkFilters {
  /** Sprint ids, plus BACKLOG. Empty means every sprint. */
  sprints: string[];
  /** Member ids, plus UNASSIGNED. Empty means everyone. */
  assignees: string[];
  /** Task statuses. Empty means every status. */
  statuses: string[];
  /** Priorities: '1' | '2' | '3', plus NO_PRIORITY. Empty means every priority. */
  priorities: string[];
  /** Title search. Never persisted: a leftover query on reopen reads as an empty board. */
  query: string;
}

export const NO_FILTERS: WorkFilters = { sprints: [], assignees: [], statuses: [], priorities: [], query: '' };

export function hasActiveFilters(f: WorkFilters): boolean {
  return f.sprints.length > 0 || f.assignees.length > 0 || f.statuses.length > 0 || f.priorities.length > 0 || f.query.trim() !== '';
}

/** Lower-case and strip accents, so "cafe" finds "Café". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function matchesFilters(t: Task, f: WorkFilters): boolean {
  if (f.sprints.length && !f.sprints.includes(t.sprintId ?? BACKLOG)) return false;
  if (f.assignees.length && !f.assignees.includes(t.assigneeId ?? UNASSIGNED)) return false;
  if (f.statuses.length && !f.statuses.includes(t.status ?? 'todo')) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority ? String(t.priority) : NO_PRIORITY)) return false;
  const q = fold(f.query.trim());
  if (q && !fold(t.text).includes(q)) return false;
  return true;
}

/**
 * Apply the filters to the outline.
 *
 * `context` is the set of tasks shown only because a descendant matched. It is filled only when
 * `withContext` is true — an outline, where a sub-task whose parent was filtered out would be drawn
 * indented under nothing. Grouped or sorted views draw no nesting (the Parent column names it), so
 * there is nothing to repair. `pinned` are tasks the user just added: shown whether they match or
 * not, because a task that vanishes the moment you create it reads as a lost write.
 */
export function applyFilters(
  outline: Task[],
  f: WorkFilters,
  tasksById: Record<ID, Task>,
  withContext: boolean,
  pinned: ReadonlySet<ID>,
): { tasks: Task[]; context: Set<ID> } {
  const context = new Set<ID>();
  if (!hasActiveFilters(f) && pinned.size === 0) return { tasks: outline, context };

  const keep = new Set<ID>();
  for (const t of outline) if (pinned.has(t.id) || matchesFilters(t, f)) keep.add(t.id);

  if (withContext) {
    for (const id of [...keep]) {
      for (const a of ancestorsOf(tasksById, id)) {
        if (!keep.has(a.id)) context.add(a.id);
      }
    }
  }
  return { tasks: outline.filter((t) => keep.has(t.id) || context.has(t.id)), context };
}

/**
 * What a task added under these filters starts as, or null when the filters do not name exactly one
 * value (two sprints selected: which one?). Null means the add line is not offered at all, rather
 * than one that would put the task somewhere the user did not choose.
 */
export function presetFromFilters(f: WorkFilters): DraftFields | null {
  if (f.sprints.length > 1 || f.assignees.length > 1) return null;
  if (f.priorities.length > 1) return null;
  if (f.statuses.length > 1) return null;
  const fields: DraftFields = {};
  if (f.statuses.length === 1) fields.status = f.statuses[0] as TaskStatus;
  if (f.sprints.length === 1) fields.sprintId = f.sprints[0] === BACKLOG ? null : f.sprints[0];
  if (f.priorities.length === 1) fields.priority = f.priorities[0] === NO_PRIORITY ? null : (Number(f.priorities[0]) as 1 | 2 | 3);
  if (f.assignees.length === 1) fields.assigneeId = f.assignees[0] === UNASSIGNED ? null : f.assignees[0];
  return fields;
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────────

const KEY = (tabId: ID) => `tw:work-filters:${tabId}`;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function load(tabId: ID): WorkFilters {
  try {
    const raw = localStorage.getItem(KEY(tabId));
    if (!raw) return NO_FILTERS;
    const p = JSON.parse(raw) as Partial<WorkFilters>;
    return { sprints: strings(p.sprints), assignees: strings(p.assignees), statuses: strings(p.statuses), priorities: strings(p.priorities), query: '' };
  } catch {
    return NO_FILTERS; // storage refused, or the value is not ours — start unfiltered
  }
}

function save(tabId: ID, f: WorkFilters): void {
  try {
    if (f.sprints.length === 0 && f.assignees.length === 0 && f.statuses.length === 0 && f.priorities.length === 0) localStorage.removeItem(KEY(tabId));
    else localStorage.setItem(KEY(tabId), JSON.stringify({ sprints: f.sprints, assignees: f.assignees, statuses: f.statuses, priorities: f.priorities }));
  } catch { /* a per-viewer convenience; a browser that refuses it just doesn't remember */ }
}

/**
 * The filters for one board, remembered per board. State carries the board it belongs to, so
 * switching boards reads the new board's filters in the same render rather than flashing the
 * previous board's for one frame.
 */
export function useWorkFilters(tabId: ID): [WorkFilters, (update: (f: WorkFilters) => WorkFilters) => void] {
  const [state, setState] = useState(() => ({ tabId, filters: load(tabId) }));
  if (state.tabId !== tabId) setState({ tabId, filters: load(tabId) });
  const current = state.tabId === tabId ? state.filters : load(tabId);

  useEffect(() => {
    save(state.tabId, state.filters);
  }, [state]);

  const update = useCallback((fn: (f: WorkFilters) => WorkFilters) => {
    setState((s) => {
      const next = fn(s.filters);
      return next === s.filters ? s : { tabId: s.tabId, filters: next };
    });
  }, []);

  return [current, update];
}

/**
 * Drop ids that no longer name anything (a deleted sprint, a removed member). A filter on
 * something that is gone shows an empty board with no control that can be unticked.
 */
export function pruneFilters(f: WorkFilters, sprintIds: ReadonlySet<ID>, memberIds: ReadonlySet<ID>): WorkFilters {
  const sprints = f.sprints.filter((s) => s === BACKLOG || sprintIds.has(s));
  const assignees = f.assignees.filter((a) => a === UNASSIGNED || memberIds.has(a));
  if (sprints.length === f.sprints.length && assignees.length === f.assignees.length) return f;
  return { ...f, sprints, assignees };
}
