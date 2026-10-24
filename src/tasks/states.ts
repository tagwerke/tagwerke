// A board's task states, for UI code (BOARD_STATES_PLAN P3.2). These are the only status helpers
// components and actions use; what each category means is in shared/status.ts.
//
// Every lookup falls back to the defaults for a board whose states haven't arrived: board creation
// is optimistic, and the seeded rows only come with the re-pull the `board-list` nudge triggers.
// The seeds are the defaults, so the fallback is exact.

import type { CSSProperties } from 'react';
import { useStore } from '../store';
import { DEFAULT_LABEL, DEFAULT_STATES, firstDoneKey, isDone, isTerminal, startKey, visible, type BoardState } from '../../shared/status';
import type { ID, Task } from '../types';

/** Every live state of the board (hidden included), in position order. Not reactive. */
export const statesOf = (tabId: ID | null | undefined): readonly BoardState[] =>
  (tabId ? useStore.getState().statesByBoard[tabId] : undefined) ?? DEFAULT_STATES;

/** The same list as a hook, so a component re-renders when an admin edits the states. */
export const useBoardStates = (tabId: ID | null | undefined): readonly BoardState[] =>
  useStore((s) => (tabId ? s.statesByBoard[tabId] : undefined) ?? DEFAULT_STATES);

/** What a picker offers. */
export const visibleStatesOf = (tabId: ID | null | undefined): BoardState[] => visible(statesOf(tabId));

/** One state of a list. A key the list doesn't have (a peer's frame racing a state edit) still
 *  renders, as a neutral open state under its default label or the raw key. */
export function stateIn(states: readonly BoardState[], key: string): BoardState {
  return (
    states.find((s) => s.key === key) ?? {
      key, label: DEFAULT_LABEL[key] ?? key, description: null, category: 'open', color: 'grey', position: Number.MAX_SAFE_INTEGER, hidden: true,
    }
  );
}

export const stateOf = (tabId: ID | null | undefined, key: string): BoardState => stateIn(statesOf(tabId), key);

export const taskIsDone = (task: Pick<Task, 'homeTabId' | 'status'>): boolean => isDone(statesOf(task.homeTabId), task.status);
export const taskIsTerminal = (task: Pick<Task, 'homeTabId' | 'status'>): boolean => isTerminal(statesOf(task.homeTabId), task.status);

/** Where a new task on this board starts (D5). */
export const startKeyOf = (tabId: ID | null | undefined): string => startKey(statesOf(tabId));
/** What ticking the checkmark sets. */
export const doneKeyOf = (tabId: ID | null | undefined): string => firstDoneKey(statesOf(tabId));

/** Paints a state: every status dot, swatch and segment reads `--state-color`. */
export const stateStyle = (state: Pick<BoardState, 'color'>): CSSProperties =>
  ({ '--state-color': `var(--state-${state.color})` }) as CSSProperties;
