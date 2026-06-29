// Seeds a new user's default workspace. Mirrors makeInitial() in src/store.ts:
// projects Work/Personal; tabs Inbox (starred), Errands. (Time planning lives in the
// Planner, not a tab.)

import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';

export async function seedUser(userId: string): Promise<void> {
  const workId = nanoid();
  const personalId = nanoid();
  const inboxId = nanoid();
  const errandsId = nanoid();

  await db.insert(schema.projects).values([
    { id: workId, userId, name: 'Work', color: '#7c3aed', position: 0 },
    { id: personalId, userId, name: 'Personal', color: '#0ea5e9', position: 1 },
  ]);

  await db.insert(schema.tabs).values([
    { id: inboxId, createdBy: userId, name: 'Inbox', type: 'normal', docJSON: null },
    { id: errandsId, createdBy: userId, name: 'Errands', type: 'normal', docJSON: null },
  ]);

  // v2: each seeded tab is a board the user owns (admin membership), which also holds
  // their personal view state. Without this the tabs are invisible (the read path
  // keys on board_members).
  await db.insert(schema.boardMembers).values([
    { tabId: inboxId, userId, role: 'admin', categoryId: workId, position: 0, starred: true, starredPosition: 0 },
    { tabId: errandsId, userId, role: 'admin', categoryId: personalId, position: 1, starred: false, starredPosition: null },
  ]);
}
