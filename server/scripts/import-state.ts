// One-shot import of a legacy ~/.do-app/state.json blob into Postgres for a user.
//
//   npm run import:state -- --user you@example.com [--password <pw>] [--file <path>]
//
// If the user does not exist it is created (password required). The user's existing
// rows are wiped first, then the blob is decomposed into normalized rows. Client
// ids are preserved verbatim so docJSON taskItem references stay valid.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema, pool } from '../db/client.ts';
import { hashPassword } from '../auth/password.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Task {
  id: string;
  homeTabId: string;
  text: string;
  date?: string;
  priority?: 1 | 2 | 3;
  owner?: string;
  done?: boolean;
}
interface Tab {
  id: string;
  projectId: string;
  name: string;
  order: number;
  starred: boolean;
  type: 'normal' | 'today';
  docJSON?: unknown;
}
interface RootState {
  projects: Record<string, { id: string; name: string; color: string; order: number }>;
  tabs: Record<string, Tab>;
  tasks: Record<string, Task>;
  starredRowOrder: string[];
}

async function main() {
  const email = arg('user')?.toLowerCase();
  if (!email) throw new Error('--user <email> is required');
  const password = arg('password');
  const file = arg('file') ?? join(homedir(), '.do-app', 'state.json');

  const raw = JSON.parse(await readFile(file, 'utf8'));
  const persistBlob = raw?.data ?? raw; // accept wrapped {data} or bare blob
  const state: RootState = persistBlob?.state ?? persistBlob;
  if (!state?.projects || !state?.tabs) throw new Error('could not find RootState in file');

  // Resolve or create the user.
  let userRow = (await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1))[0];
  if (!userRow) {
    if (!password) throw new Error(`user ${email} not found; pass --password to create it`);
    const id = nanoid();
    await db.insert(schema.users).values({ id, email, passwordHash: await hashPassword(password) });
    userRow = (await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
    console.log(`created user ${email}`);
  }
  const userId = userRow.id;

  await db.transaction(async (tx) => {
    // Wipe existing rows. Deleting the user's boards (by created_by) cascades their
    // tasks, memberships, events, and time blocks.
    await tx.delete(schema.tabs).where(eq(schema.tabs.createdBy, userId));
    await tx.delete(schema.projects).where(eq(schema.projects.userId, userId));

    const starredIdx = (id: string) => {
      const i = state.starredRowOrder.indexOf(id);
      return i >= 0 ? i : null;
    };

    const projects = Object.values(state.projects);
    if (projects.length) {
      await tx.insert(schema.projects).values(
        projects.map((p) => ({ id: p.id, userId, name: p.name, color: p.color, position: p.order })),
      );
    }

    // The legacy TODAY tab is retired (the Planner replaces it) — don't import it.
    const tabs = Object.values(state.tabs).filter((t) => t.type !== 'today');
    if (tabs.length) {
      await tx.insert(schema.tabs).values(
        tabs.map((t) => ({
          id: t.id,
          createdBy: userId,
          name: t.name,
          type: 'normal' as const,
          docJSON: t.docJSON ?? null,
        })),
      );
      // Each imported tab is a board the user admins; view state on the membership.
      await tx.insert(schema.boardMembers).values(
        tabs.map((t) => ({
          tabId: t.id,
          userId,
          role: 'admin' as const,
          categoryId: t.projectId,
          position: t.order,
          starred: t.starred,
          starredPosition: t.starred ? starredIdx(t.id) : null,
        })),
      );
    }

    const tasks = Object.values(state.tasks);
    if (tasks.length) {
      await tx.insert(schema.tasks).values(
        tasks.map((t) => ({
          id: t.id,
          createdBy: userId,
          homeTabId: t.homeTabId,
          text: t.text,
          date: t.date ?? null,
          priority: t.priority ?? null,
          owner: t.owner ?? null,
          done: t.done ?? false,
        })),
      );
    }

    console.log(
      `imported: ${projects.length} projects, ${tabs.length} tabs, ${tasks.length} tasks`,
    );
  });

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
