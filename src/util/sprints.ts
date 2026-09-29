// The one order a board's sprints are listed in: Backlog first, then the newest sprint first.
// Every list of sprints — the panel, the filter, the pickers, group-by-sprint — goes through this,
// so they cannot drift into disagreeing again. (Backlog is placed by each caller, since each one
// draws it differently; it always goes before these.)

import type { Sprint } from '../types';

/** Newest first, by start date — never by label, which is renamable and does not sort as a date. */
export function newestFirst(sprints: Sprint[]): Sprint[] {
  return [...sprints].sort((a, b) => (a.startsAt < b.startsAt ? 1 : a.startsAt > b.startsAt ? -1 : 0));
}
