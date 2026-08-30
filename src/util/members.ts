// Ranking board members against what someone has typed after an `@`.
//
// Lived in the editor's suggestion engine until the notes split took the rest of that engine with
// the document's task titles. The comment composer is the one place left that still completes a
// person's name, and this is the whole of what it needed.

import type { Member } from '../types';

const MAX_SUGGESTIONS = 10;

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
