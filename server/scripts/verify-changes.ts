/* eslint-disable @typescript-eslint/no-explicit-any -- these scripts probe untyped JSON responses */
// End-to-end check of the task change feed (GET /api/state/changes) — the poll under the realtime
// socket (src/realtime/catchup.ts). Runs against the dev DB in throwaway users and boards that it
// cleans up.
//
//   npm run verify:changes

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

process.env.SESSION_SECRET ??= 'verify-changes-secret-not-used-in-production';

const { db, pool, schema } = await import('../db/client.ts');
const { newToken } = await import('../auth/agent.ts');
const { PAT_PREFIX } = await import('../auth/pat.ts');
const { createSession, SESSION_COOKIE } = await import('../auth/session.ts');
const { stateRoutes } = await import('../routes/state.ts');
const { seedBoardStates } = await import('../lib/boardStates.ts');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const [me, other, boardA, boardB, boardX, taskA, taskB, taskX] = Array.from({ length: 8 }, () => nanoid());

async function seed(): Promise<void> {
  await db.insert(schema.users).values([
    { id: me, email: `me-${me}@verify.test`, role: 'member' },
    { id: other, email: `other-${other}@verify.test`, role: 'member' },
  ]);
  await db.insert(schema.tabs).values([
    { id: boardA, name: 'verify-changes A', type: 'normal', createdBy: me },
    { id: boardB, name: 'verify-changes B', type: 'normal', createdBy: other },
    { id: boardX, name: 'verify-changes X (not mine)', type: 'normal', createdBy: other },
  ]);
  for (const b of [boardA, boardB, boardX]) await seedBoardStates(db, b);
  await db.insert(schema.boardMembers).values([
    { tabId: boardA, userId: me, role: 'admin', position: 0 },
    { tabId: boardB, userId: me, role: 'viewer', position: 1 },
    { tabId: boardB, userId: other, role: 'admin' },
    { tabId: boardX, userId: other, role: 'admin' },
  ]);
  await db.insert(schema.tasks).values([
    { id: taskA, homeTabId: boardA, text: 'A', status: 'todo', createdBy: me, rank: 'a0' },
    { id: taskB, homeTabId: boardB, text: 'B', status: 'todo', createdBy: other, rank: 'a0' },
    { id: taskX, homeTabId: boardX, text: 'X', status: 'todo', createdBy: other, rank: 'a0' },
  ]);
}

async function cleanup(): Promise<void> {
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [boardA, boardB, boardX])); // cascades tasks, members
  await db.delete(schema.users).where(inArray(schema.users.id, [me, other])); // cascades tokens, sessions
}

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
await app.register(stateRoutes);

try {
  await seed();
  const cookies = { [SESSION_COOKIE]: app.signCookie(await createSession(me)) };
  const get = async (q: string, extra: Record<string, unknown> = { cookies }) => {
    const r = await app.inject({ method: 'GET', url: `/api/state/changes${q}`, ...extra });
    return { status: r.statusCode, body: r.json() as any };
  };
  const ids = (b: any) => (b.tasks as any[]).map((t) => t.id);

  console.log('access');
  check('no session -> 401', (await get('?since=0', {})).status === 401);
  check('missing since -> 400', (await get('')).status === 400);
  check('garbage since -> 400', (await get('?since=abc')).status === 400);

  const all = await get('?since=0');
  check('since=0 -> 200', all.status === 200, all.body);
  check('sees tasks on my boards (admin + viewer)', ids(all.body).includes(taskA) && ids(all.body).includes(taskB), ids(all.body));
  check('never sees a board I am not on', !ids(all.body).includes(taskX));
  check('cursor = newest updatedAt returned', all.body.cursor === Math.max(...(all.body.tasks as any[]).map((t) => t.updatedAt)), all.body.cursor);
  check('rows are full task DTOs', (all.body.tasks as any[]).every((t) => typeof t.homeTabId === 'string' && typeof t.text === 'string' && typeof t.updatedAt === 'number'));

  console.log('changes after the cursor');
  // The overlap window re-reads the last few seconds BEFORE the cursor, so a quiet poll returns
  // rows the client already holds at the same updatedAt — which it skips (catchup.ts apply()).
  const quiet = await get(`?since=${all.body.cursor}`);
  const seen = new Map((all.body.tasks as any[]).map((t) => [t.id, t.updatedAt]));
  check('quiet -> only rows already held, same version', (quiet.body.tasks as any[]).every((t) => seen.get(t.id) === t.updatedAt) && quiet.body.deleted.length === 0, quiet.body);
  check('quiet -> cursor unchanged', quiet.body.cursor === all.body.cursor);

  // A peer writes: the trigger bumps updated_at with no help from the route.
  await db.update(schema.tasks).set({ text: 'B edited by a peer' }).where(eq(schema.tasks.id, taskB));
  await db.insert(schema.tasks).values({ id: nanoid(), homeTabId: boardA, text: 'new from laptop', status: 'todo', createdBy: me, rank: 'a1' });
  await db.update(schema.tasks).set({ deletedAt: new Date(), deletedBy: other }).where(eq(schema.tasks.id, taskA));
  await db.update(schema.tasks).set({ text: 'X edited' }).where(eq(schema.tasks.id, taskX));

  const after = await get(`?since=${all.body.cursor}`);
  const texts = (after.body.tasks as any[]).map((t) => t.text);
  check('peer edit arrives', texts.includes('B edited by a peer'), texts);
  check('new task arrives', texts.includes('new from laptop'), texts);
  check('soft delete arrives as deleted id', after.body.deleted.includes(taskA) && !ids(after.body).includes(taskA), after.body.deleted);
  check('edit on a foreign board stays out', !ids(after.body).includes(taskX));
  check('cursor advances', after.body.cursor > all.body.cursor);
  check('more=false on a small page', after.body.more === false);

  console.log('personal access token');
  const t = newToken(PAT_PREFIX);
  await db.insert(schema.personalAccessTokens).values({
    id: nanoid(), userId: me, label: 'verify', tokenHash: t.hash, scopes: [], allBoards: false, tabIds: [boardB],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const viaPat = await get('?since=0', { headers: { authorization: `Bearer ${t.token}` } });
  check('PAT read -> 200', viaPat.status === 200, viaPat.body);
  check('PAT sees only the boards it reaches', ids(viaPat.body).includes(taskB) && (viaPat.body.tasks as any[]).every((x) => x.homeTabId === boardB), ids(viaPat.body));
} finally {
  await cleanup();
  await app.close();
  await pool.end();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
