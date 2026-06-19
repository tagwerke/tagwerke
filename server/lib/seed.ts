// Seeds a new user's default workspace. Mirrors makeInitial() in src/store.ts:
// projects Work/Personal; tabs TODAY (type today, starred), Inbox (starred), Errands.

import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function seedUser(userId: string): Promise<void> {
  const workId = nanoid();
  const personalId = nanoid();
  const todayId = nanoid();
  const inboxId = nanoid();
  const errandsId = nanoid();

  await db.insert(schema.projects).values([
    { id: workId, userId, name: 'Work', color: '#7c3aed', position: 0 },
    { id: personalId, userId, name: 'Personal', color: '#0ea5e9', position: 1 },
  ]);

  await db.insert(schema.tabs).values([
    {
      id: todayId,
      userId,
      createdBy: userId,
      projectId: workId,
      name: 'TODAY',
      position: 0,
      starred: true,
      starredPosition: 0,
      type: 'today',
      dateKey: todayISO(),
      docJSON: null,
    },
    {
      id: inboxId,
      userId,
      createdBy: userId,
      projectId: workId,
      name: 'Inbox',
      position: 1,
      starred: true,
      starredPosition: 1,
      type: 'normal',
      docJSON: null,
    },
    {
      id: errandsId,
      userId,
      createdBy: userId,
      projectId: personalId,
      name: 'Errands',
      position: 2,
      starred: false,
      starredPosition: null,
      type: 'normal',
      docJSON: null,
    },
  ]);

  // v2: each seeded tab is a board the user owns (admin membership), which also holds
  // their personal view state. Without this the tabs are invisible (the read path
  // keys on board_members).
  await db.insert(schema.boardMembers).values([
    { tabId: todayId, userId, role: 'admin', categoryId: workId, position: 0, starred: true, starredPosition: 0 },
    { tabId: inboxId, userId, role: 'admin', categoryId: workId, position: 1, starred: true, starredPosition: 1 },
    { tabId: errandsId, userId, role: 'admin', categoryId: personalId, position: 2, starred: false, starredPosition: null },
  ]);
}
