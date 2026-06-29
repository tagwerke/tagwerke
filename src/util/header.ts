// Fuzzy ranking of tabs by a query (exact > prefix > project-prefix > includes). Used
// by the Planner's tab picker (TimeBlockCard). Returns matches richest-first.

import type { ID, Project, Tab } from '../types';

export interface TabMatch {
  tabId: ID;
  name: string;
  projectName: string;
  projectColor: string;
  score: number;
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

    let score: number;
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
