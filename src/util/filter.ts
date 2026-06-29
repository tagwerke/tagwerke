// Shared task-filter predicates. One implementation feeds both the Board (which asks
// "does any task on this tab match the active Filter?") and the Planner mini-board
// (which projects a tab's live tasks through a per-block BlockFilter).

import type { Task, BlockFilter } from '../types';
import { isDueSoon } from './dates';

/**
 * The task-level facets shared by {@link Filter} and {@link BlockFilter}:
 * owner / priority / has-date / due-soon. (project/query are handled by callers since
 * they compare against tab-level data, not the task.)
 */
export function matchesTaskFacets(
  task: Task,
  f: { owners?: string[]; priorities?: (1 | 2 | 3)[]; hasDate?: boolean; dueSoon?: boolean },
): boolean {
  if (f.owners?.length && !(task.owner && f.owners.includes(task.owner))) return false;
  if (f.priorities?.length && !(task.priority && f.priorities.includes(task.priority))) return false;
  if (f.hasDate && !task.date) return false;
  if (f.dueSoon && !(task.date && isDueSoon(task.date))) return false;
  return true;
}

/** Does a single task pass a block's optional projection filter? No filter → always true. */
export function matchesBlockFilter(task: Task, f?: BlockFilter | null): boolean {
  if (!f) return true;
  if (!matchesTaskFacets(task, { priorities: f.priorities, hasDate: f.hasDate, dueSoon: f.dueSoon })) return false;
  if (f.statuses?.length && !f.statuses.includes(task.status ?? 'todo')) return false;
  const q = f.query?.trim().toLowerCase();
  if (q && !task.text.toLowerCase().includes(q)) return false;
  return true;
}
