// Pure helpers for the CSV importer (ImportCsvSheet.tsx). Kept separate from the component,
// matching the existing parse.ts/dates.ts split of logic from UI.

import type { TaskStatus } from '../types';
import { toISO } from './dates';

export const TITLE_CANDIDATES = ['title', 'name', 'task', 'summary'];
export const STATUS_CANDIDATES = ['status', 'state'];
export const ASSIGNEE_CANDIDATES = ['assignee', 'owner', 'email'];
export const PRIORITY_CANDIDATES = ['priority', 'pri'];
export const DATE_CANDIDATES = ['date', 'due', 'due date'];
// Sub-task nesting (SUBTASKS_PLAN P7). The cell names the PARENT by title — an exported CSV from
// another tool has no idea what Tagwerke's ids are, but it does know what the parent was called.
export const PARENT_CANDIDATES = ['parent', 'parent task', 'parent title', 'subtask of', 'epic'];

/** First header whose name matches one of `candidates` (case-insensitive), or null. */
export function suggestColumn(headers: string[], candidates: string[]): string | null {
  const wanted = candidates.map((c) => c.toLowerCase());
  return headers.find((h) => wanted.includes(h.trim().toLowerCase())) ?? null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(s: string | undefined | null): boolean {
  return !!s && EMAIL_RE.test(s.trim());
}

// Best-effort synonym table. Tagwerke's scale runs the OPPOSITE of the common "P1 = most
// urgent" convention: priority 3 is highest (rendered as "!!!"), 1 is lowest (see TaskMeta.tsx
// and util/parse.ts's `!`/`!!`/`!!!` tokens). Anything unrecognized (including bare "1"/"2"/"3",
// whose source convention we can't know) passes through unmapped rather than guess wrong.
const PRIORITY_SYNONYMS: Record<string, 1 | 2 | 3> = {
  low: 1, lowest: 1, p3: 1,
  medium: 2, med: 2, p2: 2,
  high: 3, highest: 3, urgent: 3, p1: 3,
};

export function parsePriorityRaw(raw: string | undefined | null): 1 | 2 | 3 | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === '2' || v === '3') return Number(v) as 1 | 2 | 3;
  return PRIORITY_SYNONYMS[v] ?? null;
}

export function parseDateRaw(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : toISO(d);
}

/** Every distinct non-empty value of `column` actually present in `rows`, in first-seen order. */
export function distinctValues(rows: Record<string, string>[], column: string | null): string[] {
  if (!column) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const v = (row[column] ?? '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// Best-effort default mapping for the status-mapping step's pre-fill; the user can override
// any of these. Unrecognized values default to 'todo' and are left for the user to fix.
const STATUS_SYNONYMS: Record<string, TaskStatus> = {
  'to do': 'todo', todo: 'todo', open: 'todo', backlog: 'todo', new: 'todo',
  doing: 'in_progress', 'in progress': 'in_progress', wip: 'in_progress', started: 'in_progress',
  'in review': 'in_review', review: 'in_review', reviewing: 'in_review', 'code review': 'in_review',
  done: 'done', closed: 'done', complete: 'done', completed: 'done', resolved: 'done',
  cancelled: 'cancelled', canceled: 'cancelled', wontfix: 'cancelled', "won't fix": 'cancelled',
};

export function suggestStatus(raw: string): TaskStatus {
  return STATUS_SYNONYMS[raw.trim().toLowerCase()] ?? 'todo';
}
