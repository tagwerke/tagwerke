// Parsing for Today block headers — paragraphs that start with a time token.
//
// Shapes accepted as the leading time token:
//   6to10            06:00 – 10:00
//   630to10          06:30 – 10:00
//   630to1330        06:30 – 13:30
//   06:30 to 13:30   canonical
//
// Digit rules when no explicit colon:
//   1–2 digits → hours only (8 → 08:00)
//   3 digits   → H:MM       (630 → 06:30)
//   4 digits   → HH:MM      (1330 → 13:30)

import type { ID, Project, Tab } from '../types';

const TIME_ANCHORED =
  /^\s*(\d{1,4})\s*(?::\s*(\d{1,2}))?\s*to\s*(\d{1,4})\s*(?::\s*(\d{1,2}))?/i;

function digitsToHM(digits: string, explicitMin?: string): [number, number] | null {
  if (explicitMin != null) {
    const h = parseInt(digits, 10);
    const m = parseInt(explicitMin, 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return [h, m];
  }
  const len = digits.length;
  if (len === 0) return null;
  if (len <= 2) return [parseInt(digits, 10), 0];
  if (len === 3) return [parseInt(digits[0], 10), parseInt(digits.slice(1), 10)];
  if (len === 4) return [parseInt(digits.slice(0, 2), 10), parseInt(digits.slice(2), 10)];
  return null;
}

function hmValid(hm: [number, number] | null): hm is [number, number] {
  if (!hm) return false;
  const [h, m] = hm;
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function hmString(hm: [number, number]): string {
  return `${String(hm[0]).padStart(2, '0')}:${String(hm[1]).padStart(2, '0')}`;
}

export interface HeaderParse {
  /** Whether the paragraph text starts with a recognized time token. */
  isHeader: boolean;
  /** Length of the matched time token in the text (incl. leading whitespace handled). */
  tokenLen: number;
  start?: string; // "HH:MM"
  end?: string;
  /** Text after the time token (the tab query / freeform suffix). */
  remainder: string;
  /** Normalized form of the time token. */
  normalizedToken?: string;
  /** Best-matching tab id (if any). */
  tabId?: ID;
  /** All tab matches, ranked. */
  matches: TabMatch[];
}

export interface TabMatch {
  tabId: ID;
  name: string;
  projectName: string;
  projectColor: string;
  score: number;
}

export function parseHeader(
  text: string,
  tabs: Record<ID, Tab>,
  projects: Record<ID, Project>,
  tabOrder: ID[],
): HeaderParse {
  const m = text.match(TIME_ANCHORED);
  if (!m) {
    return { isHeader: false, tokenLen: 0, remainder: text, matches: [] };
  }
  const startHM = digitsToHM(m[1], m[2]);
  const endHM = digitsToHM(m[3], m[4]);
  if (!hmValid(startHM) || !hmValid(endHM)) {
    return { isHeader: false, tokenLen: 0, remainder: text, matches: [] };
  }
  const start = hmString(startHM);
  const end = hmString(endHM);
  const tokenLen = m[0].length;
  const remainder = text.slice(tokenLen).trim();
  const normalizedToken = `${start} to ${end}`;

  const matches = rankTabs(remainder, tabs, projects, tabOrder);
  return {
    isHeader: true,
    tokenLen,
    start,
    end,
    remainder,
    normalizedToken,
    tabId: matches[0]?.tabId,
    matches,
  };
}

export function rankTabs(
  query: string,
  tabs: Record<ID, Tab>,
  projects: Record<ID, Project>,
  tabOrder: ID[],
): TabMatch[] {
  const q = query.trim().toLowerCase();
  const out: TabMatch[] = [];
  for (const tid of tabOrder) {
    const tab = tabs[tid];
    if (!tab || tab.type !== 'normal') continue;
    const proj = projects[tab.projectId];
    const projName = proj?.name ?? '';
    const projColor = proj?.color ?? '#888';
    const n = tab.name.toLowerCase();
    const p = projName.toLowerCase();

    let score = 0;
    if (!q) {
      score = 1; // include all when query is empty
    } else if (n === q) score = 200;
    else if (n.startsWith(q)) score = 100 + q.length;
    else if ((`${p} · ${n}`).startsWith(q)) score = 90 + q.length;
    else if (n.includes(q)) score = 50 + q.length;
    else if (p.includes(q)) score = 30 + q.length;
    else continue;

    score += Math.max(0, 20 - n.length) * 0.05;
    out.push({ tabId: tid, name: tab.name, projectName: projName, projectColor: projColor, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Build a normalized header text from a header line's components. */
export function buildHeaderText(start: string, end: string, suffix: string): string {
  const s = suffix.trim();
  return s ? `${start} to ${end} ${s}` : `${start} to ${end}`;
}

/** Is this text a valid header? Useful for quick checks without ranking. */
export function isHeaderText(text: string): boolean {
  const m = text.match(TIME_ANCHORED);
  if (!m) return false;
  const startHM = digitsToHM(m[1], m[2]);
  const endHM = digitsToHM(m[3], m[4]);
  return hmValid(startHM) && hmValid(endHM);
}
