// Task states, shared by client and server.
//
// Each board defines its own states (the `board_states` table, BOARD_STATES_PLAN.md). A state has
// a KEY (what the task row stores, never changes), a LABEL (what people read, editable) and a
// CATEGORY (what the app's logic means by it). Logic asks about the category, never the key or
// the label: "is this finished?", "can an agent set it?", "is it overdue?" are questions about
// meaning, and on a lead-gen board the done state may be called "Won".
//
//   open     not started
//   active   being worked on
//   waiting  alive but stalled on someone or something (blocked, in review)
//   done     finished successfully — terminal
//   closed   finished without success (cancelled, lost) — terminal
//
// Every helper here takes the board's state list, so the server and the client answer these
// questions the same way.

export const STATUS_CATEGORIES = ['open', 'active', 'waiting', 'done', 'closed'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Every board must always keep at least one visible state of each of these (D2). */
export const REQUIRED_CATEGORIES: readonly StatusCategory[] = ['open', 'done'];

/** Most live states a board may have. */
export const MAX_STATES = 12;

/** The palette (D6): named tokens, each a `--state-<name>` CSS variable with light and dark values. */
export const STATE_COLORS = ['grey', 'slate', 'blue', 'sky', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'purple'] as const;
export type StateColor = (typeof STATE_COLORS)[number];

/** The color a new custom state gets from its category. */
export const CATEGORY_DEFAULT_COLOR: Record<StatusCategory, StateColor> = {
  open: 'grey',
  active: 'blue',
  waiting: 'orange',
  done: 'green',
  closed: 'slate',
};

export interface BoardState {
  key: string;
  label: string;
  description: string | null;
  category: StatusCategory;
  color: string;
  position: number;
  hidden: boolean;
}

/** What every board starts with: the migration's seed and every board creation use these. In order. */
export const DEFAULT_STATES: readonly BoardState[] = [
  { key: 'todo', label: 'Todo', category: 'open', color: 'grey', description: 'Not started yet.' },
  { key: 'in_progress', label: 'In progress', category: 'active', color: 'blue', description: 'Someone is working on it.' },
  { key: 'blocked', label: 'Blocked', category: 'waiting', color: 'red', description: 'Stuck on someone or something. Say what in a comment.' },
  { key: 'in_review', label: 'In review', category: 'waiting', color: 'purple', description: 'Work is done and waiting for someone to look at it.' },
  { key: 'done', label: 'Done', category: 'done', color: 'green', description: 'Finished.' },
  { key: 'cancelled', label: 'Cancelled', category: 'closed', color: 'slate', description: "Dropped. It won't be done." },
].map((s, position) => ({ ...s, category: s.category as StatusCategory, position, hidden: false }));

/** Key → label of the defaults. History entries written before per-board states carry only a key,
 *  and those keys always had these labels. */
export const DEFAULT_LABEL: Record<string, string> = Object.fromEntries(DEFAULT_STATES.map((s) => [s.key, s.label]));

type StateList = readonly Pick<BoardState, 'key' | 'category' | 'hidden' | 'position'>[];

/** The states a picker offers, in position order. */
export const visible = <S extends Pick<BoardState, 'hidden' | 'position'>>(states: readonly S[]): S[] =>
  states.filter((s) => !s.hidden).sort((a, b) => a.position - b.position);

/** The category of a key on this board; an unknown key reads as `open`, the safe reading. */
export function categoryOf(states: StateList, key: string | null | undefined): StatusCategory {
  return states.find((s) => s.key === key)?.category ?? 'open';
}

/** Finished successfully. */
export const isDone = (states: StateList, key: string | null | undefined): boolean => categoryOf(states, key) === 'done';

/** Finished either way: nothing left to do, so no overdue flag, no sprint rollover, no cascade. */
export function isTerminal(states: StateList, key: string | null | undefined): boolean {
  const c = categoryOf(states, key);
  return c === 'done' || c === 'closed';
}

/** Where a new task starts, and where un-ticking a done task returns it (D5): the first visible
 *  `open` state. D2 guarantees there is one; `todo` covers a list that hasn't loaded. */
export const startKey = (states: StateList): string => visible(states).find((s) => s.category === 'open')?.key ?? 'todo';

/** What ticking the checkmark sets: the first visible `done` state. */
export const firstDoneKey = (states: StateList): string => visible(states).find((s) => s.category === 'done')?.key ?? 'done';

/** Where a task on `key` goes when that state is deleted (D7's preselect, D8's remap): the next
 *  visible state of the same category by position, else the previous one, else the start state. */
export function nextSameCategory(states: readonly (Pick<BoardState, 'key' | 'category' | 'hidden' | 'position'>)[], key: string): string {
  const from = states.find((s) => s.key === key);
  if (!from) return startKey(states);
  const same = visible(states).filter((s) => s.category === from.category && s.key !== key);
  return (same.find((s) => s.position > from.position) ?? same[same.length - 1])?.key ?? startKey(states.filter((s) => s.key !== key));
}
