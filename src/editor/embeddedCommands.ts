// Parses `/command` and `@mention` tokens embedded ANYWHERE in a task title (not just at the
// caret, unlike the interactive popup in TaskTitleSuggest.tsx) — e.g. a title typed or imported
// as "Fix login bug /p1 /due tomorrow @kirill" becomes the title "Fix login bug" plus
// priority/date/assignee fields. Deliberately conservative: with no interactive popup to confirm a
// pick, only EXACT, unambiguous tokens resolve (specific status aliases, "today"/"tomorrow", a
// resolvable "/due <arg>", "p1"/"p2"/"p3", and a confidently-matched @name). Anything else —
// generic "/due" with no date, "/status", "/priority", a typo, an ambiguous or unmatched @name —
// is left in the title as literal text rather than guessed at. Pure function: the caller (the
// title-commit hook today, a CSV/Jira importer later) decides how to apply the returned fields.

import { STATUS_DEFS } from './suggestEngine';
import { resolveDateKeyword, toISO, todayISO } from '../util/dates';
import type { ID, Member, TaskStatus } from '../types';

export interface EmbeddedFields {
  status?: TaskStatus;
  date?: string;
  /** `null` means "clear it" (from /p0), as opposed to not mentioned at all. */
  priority?: 1 | 2 | 3 | null;
  /** `null` means "clear it" (from /unassign). */
  assigneeId?: ID | null;
}

export interface EmbeddedParseResult {
  cleanText: string;
  fields: EmbeddedFields;
}

const SPECIFIC_STATUS_ALIASES: { alias: string; status: TaskStatus }[] = STATUS_DEFS.flatMap((st) =>
  st.aliases.filter((a) => a !== 'status').map((alias) => ({ alias, status: st.s }))
);

const TOKEN_WORDS = ['today', 'tomorrow', ...SPECIFIC_STATUS_ALIASES.map((a) => a.alias), 'p1', 'p2', 'p3', 'p0', 'unassign', 'me'];

const DUE_RE = /(^|\s)\/(due|date)[ \t]+(\S+)/gi;
const TOKEN_RE = new RegExp(`(^|\\s)\\/(${TOKEN_WORDS.join('|')})(?!\\w)`, 'gi');
const MENTION_RE = /(^|\s)@(\w+)/g;

/** Only an exact-name or exact-prefix match, with no tie, counts as confident enough to auto-assign. */
function confidentMember(members: Member[], query: string): Member | undefined {
  const q = query.toLowerCase();
  if (!q) return undefined;
  let best: Member | undefined;
  let bestScore = -1;
  let tied = false;
  for (const m of members) {
    const n = m.name.toLowerCase();
    const s = n === q ? 200 : n.startsWith(q) ? 100 : -1;
    if (s > bestScore) { bestScore = s; best = m; tied = false; }
    else if (s === bestScore && s >= 0) tied = true;
  }
  return bestScore >= 100 && !tied ? best : undefined;
}

interface Removal { start: number; end: number }

export function parseEmbeddedCommands(text: string, members: Member[], meId?: ID): EmbeddedParseResult {
  const fields: EmbeddedFields = {};
  const removals: Removal[] = [];

  for (const m of text.matchAll(DUE_RE)) {
    const resolved = resolveDateKeyword(m[3]);
    if (resolved === undefined) continue; // "/due" with no usable date — leave as literal
    fields.date = resolved;
    removals.push({ start: m.index + m[1].length, end: m.index + m[0].length });
  }

  for (const m of text.matchAll(TOKEN_RE)) {
    const word = m[2].toLowerCase();
    let resolved = true;
    if (word === 'today') fields.date = todayISO();
    else if (word === 'tomorrow') {
      const tm = new Date();
      tm.setDate(tm.getDate() + 1);
      fields.date = toISO(tm);
    } else if (word === 'p1' || word === 'p2' || word === 'p3') {
      fields.priority = Number(word[1]) as 1 | 2 | 3;
    } else if (word === 'p0') {
      fields.priority = null;
    } else if (word === 'unassign') {
      fields.assigneeId = null;
    } else if (word === 'me') {
      if (meId) fields.assigneeId = meId;
      else resolved = false; // no session context to resolve "me" against — leave it literal
    } else {
      const hit = SPECIFIC_STATUS_ALIASES.find((a) => a.alias === word);
      if (hit) fields.status = hit.status;
      else resolved = false;
    }
    if (resolved) removals.push({ start: m.index + m[1].length, end: m.index + m[0].length });
  }

  for (const m of text.matchAll(MENTION_RE)) {
    const match = confidentMember(members, m[2]);
    if (!match) continue; // no clear match — leave "@whatever" as literal text
    fields.assigneeId = match.id;
    removals.push({ start: m.index + m[1].length, end: m.index + m[0].length });
  }

  removals.sort((a, b) => a.start - b.start);
  let cleanText = text;
  for (let i = removals.length - 1; i >= 0; i--) {
    const r = removals[i];
    cleanText = cleanText.slice(0, r.start) + cleanText.slice(r.end);
  }
  cleanText = cleanText.replace(/[ \t]{2,}/g, ' ').trim();

  return { cleanText, fields };
}
