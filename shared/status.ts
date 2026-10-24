// Task statuses, shared by client and server.
//
// A status has a KEY (what the row stores), a LABEL (what people read) and a CATEGORY (what the
// app's logic means by it). Logic asks about the category, never the key: "is this finished?",
// "can an agent set it?", "is it overdue?" are questions about meaning, and the day a board can
// rename or add statuses, the key stops being something code may compare against.
//
//   open     not started
//   active   being worked on
//   waiting  alive but stalled on someone or something (blocked, in review)
//   done     finished successfully — terminal
//   closed   finished without success (cancelled, lost) — terminal
//
// Color is per status, not per category (see index.css): blocked and in-review are both `waiting`
// but must not look alike.

export const STATUS_CATEGORIES = ['open', 'active', 'waiting', 'done', 'closed'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** In dropdown order. */
export const TASK_STATUSES = [
  { key: 'todo', label: 'Todo', category: 'open' },
  { key: 'in_progress', label: 'In progress', category: 'active' },
  { key: 'blocked', label: 'Blocked', category: 'waiting' },
  { key: 'in_review', label: 'In review', category: 'waiting' },
  { key: 'done', label: 'Done', category: 'done' },
  { key: 'cancelled', label: 'Cancelled', category: 'closed' },
] as const satisfies readonly { key: string; label: string; category: StatusCategory }[];

export type TaskStatus = (typeof TASK_STATUSES)[number]['key'];

export const TASK_STATUS_KEYS = TASK_STATUSES.map((s) => s.key) as [TaskStatus, ...TaskStatus[]];

/** What a task with no status (a row from before statuses existed) is. */
export const DEFAULT_STATUS: TaskStatus = 'todo';

const CATEGORY_OF: Record<string, StatusCategory> = Object.fromEntries(TASK_STATUSES.map((s) => [s.key, s.category]));

/** The category of a status; an unknown or missing one is `open`, the safe reading. */
export function statusCategory(status: string | null | undefined): StatusCategory {
  return CATEGORY_OF[status ?? DEFAULT_STATUS] ?? 'open';
}

/** Finished successfully. */
export const isDoneStatus = (status: string | null | undefined): boolean => statusCategory(status) === 'done';

/** Finished either way: nothing left to do, so no overdue flag, no sprint rollover, no cascade. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  const c = statusCategory(status);
  return c === 'done' || c === 'closed';
}

/** Keys of every terminal status, for SQL `status IN (...)`. */
export const TERMINAL_STATUS_KEYS: TaskStatus[] = TASK_STATUSES.filter((s) => s.category === 'done' || s.category === 'closed').map((s) => s.key);

/** What an agent may set: everything except finishing the work, which is a human's call. */
export const AGENT_STATUS_KEYS = TASK_STATUSES.filter((s) => s.category !== 'done').map((s) => s.key) as [TaskStatus, ...TaskStatus[]];
