// Pure matching/ranking logic shared by the interactive "/" + "@" popup (TaskTitleSuggest.tsx)
// and the embedded-command parser (embeddedCommands.ts) that reads a whole committed title in one
// pass (e.g. for imports). No React/DOM/store coupling here on purpose — both call sites plug in
// their own way of applying the result.

import { resolveDateKeyword, formatDateChip, toISO, todayISO } from '../util/dates';
import type { ID, Member, TaskStatus } from '../types';

export const MAX_SUGGESTIONS = 10;

// Each patch touches exactly ONE field, with `null` meaning "clear it". Splitting date/priority/
// assignee into separate kinds (rather than one "meta" patch with both fields present) matters:
// a patch object literal with an unrelated key set to `undefined` (e.g. `{ date: X, priority:
// undefined }`) still clobbers the existing value on spread — undefined-as-a-present-key isn't
// the same as the key being absent.
export type CommandPatch =
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'date'; date: string | null }
  | { kind: 'priority'; priority: 1 | 2 | 3 | null }
  | { kind: 'assignee'; assigneeId: ID | null };

export interface CommandDef {
  key: string;
  label: string;
  /** Every alias this def responds to. First entries are often a shared/ambiguous group keyword
   *  (e.g. "due", "status", "priority"); later ones are specific to this one def (e.g. "tomorrow"). */
  keywords: string[];
  patch: CommandPatch;
}

export const STATUS_DEFS: { s: TaskStatus; label: string; aliases: string[] }[] = [
  { s: 'todo', label: 'Todo', aliases: ['status', 'todo'] },
  { s: 'in_progress', label: 'In progress', aliases: ['status', 'doing', 'wip', 'inprogress'] },
  { s: 'in_review', label: 'In review', aliases: ['status', 'review', 'inreview'] },
  { s: 'done', label: 'Done', aliases: ['status', 'done'] },
  { s: 'cancelled', label: 'Cancelled', aliases: ['status', 'cancel', 'cancelled'] },
];

function staticDefs(meId: ID | undefined): CommandDef[] {
  const tm = new Date();
  tm.setDate(tm.getDate() + 1);
  const defs: CommandDef[] = [
    { key: 'due-today', label: 'Due · today', keywords: ['due', 'date', 'today'], patch: { kind: 'date', date: todayISO() } },
    { key: 'due-tomorrow', label: 'Due · tomorrow', keywords: ['due', 'date', 'tomorrow'], patch: { kind: 'date', date: toISO(tm) } },
  ];
  for (const st of STATUS_DEFS)
    defs.push({ key: `st-${st.s}`, label: `Status · ${st.label}`, keywords: st.aliases, patch: { kind: 'status', status: st.s } });
  for (const p of [1, 2, 3] as const)
    defs.push({ key: `p${p}`, label: `Priority · ${'!'.repeat(p)}`, keywords: ['priority', 'p', `p${p}`], patch: { kind: 'priority', priority: p } });
  defs.push({ key: 'p0', label: 'Priority · none', keywords: ['priority', 'p', 'p0', 'noprio'], patch: { kind: 'priority', priority: null } });
  defs.push({ key: 'unassign', label: 'Unassign', keywords: ['unassign', 'noassign'], patch: { kind: 'assignee', assigneeId: null } });
  if (meId) defs.push({ key: 'me', label: 'Assign · me', keywords: ['me'], patch: { kind: 'assignee', assigneeId: meId } });
  return defs;
}

/** Best score this def's keywords earn against the typed `cmd` — exact beats prefix, no match is -1. */
function score(keywords: string[], cmd: string): number {
  if (cmd === '') return 0;
  let best = -1;
  for (const kw of keywords) {
    if (kw === cmd) best = Math.max(best, 200);
    else if (kw.startsWith(cmd)) best = Math.max(best, 100);
  }
  return best;
}

/**
 * Per-item filter + rank for the "/" popup: every candidate is scored on its OWN keywords (not
 * gated as a whole group), so e.g. typing "/p1" surfaces only Priority·! and not p2/p3 alongside
 * it, and typing "/tomorrow" surfaces only "Due · tomorrow", not "Due · today" too.
 */
export function matchCommands(cmd: string, arg: string, meId?: ID): CommandDef[] {
  let defs = staticDefs(meId);
  const resolved = arg ? resolveDateKeyword(arg) : undefined;
  if (resolved !== undefined) {
    // A resolvable arg ("/due friday", "/due tomorrow") is a specific answer — drop the generic
    // today/tomorrow shortcuts so a literal "/due tomorrow" doesn't show "Due · tomorrow" twice.
    defs = defs.filter((d) => d.key !== 'due-today' && d.key !== 'due-tomorrow');
    defs.unshift({ key: 'due-arg', label: `Due · ${formatDateChip(resolved)}`, keywords: ['due', 'date'], patch: { kind: 'date', date: resolved } });
  }
  return defs
    .map((d) => ({ d, s: score(d.keywords, cmd) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.d);
}

/** Group label for the "/" popup — lets the UI insert a header whenever the (already relevance-
 *  sorted) list crosses from one category into another, without disturbing that sort order. */
export function categoryOf(patch: CommandPatch): string {
  switch (patch.kind) {
    case 'date': return 'Due';
    case 'status': return 'Status';
    case 'priority': return 'Priority';
    case 'assignee': return 'Assign';
  }
}

export function rankMembers(members: Member[], query: string): Member[] {
  const q = query.toLowerCase();
  if (!q) return members.slice(0, MAX_SUGGESTIONS);
  const scored: { m: Member; score: number }[] = [];
  for (const m of members) {
    const n = m.name.toLowerCase();
    const e = m.email.toLowerCase();
    let s = -1;
    if (n === q) s = 200;
    else if (n.startsWith(q)) s = 100;
    else if (n.includes(q)) s = 50;
    else if (e.includes(q)) s = 30;
    if (s >= 0) scored.push({ m, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.m);
}
