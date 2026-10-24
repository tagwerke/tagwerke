/* eslint-disable @typescript-eslint/no-explicit-any -- these scripts probe untyped JSON responses */
// End-to-end check of per-board task states (BOARD_STATES_PLAN.md P1–P2): task writes validated
// against the board's own list, and the admin-only editing API with its rules. Runs against the
// dev DB in throwaway users and boards that it cleans up.
//
//   npm run verify:board-states

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

process.env.SESSION_SECRET ??= 'verify-board-states-secret-not-used-in-production';

const { db, pool, schema } = await import('../db/client.ts');
const { newToken } = await import('../auth/agent.ts');
const { PAT_PREFIX } = await import('../auth/pat.ts');
const { createSession, SESSION_COOKIE } = await import('../auth/session.ts');
const { registerAuditHook } = await import('../lib/audit.ts');
const { taskRoutes } = await import('../routes/tasks.ts');
const { boardStateRoutes } = await import('../routes/boardStates.ts');
const { seedBoardStates } = await import('../lib/boardStates.ts');
const { MAX_STATES } = await import('../../shared/status.ts');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const [admin, editor, board, taskA, taskB, taskTrashed, event, boardDefault, boardLeads, lead, leadKid, plain] = Array.from({ length: 12 }, () => nanoid());

async function seed(): Promise<void> {
  await db.insert(schema.users).values([
    { id: admin, email: `admin-${admin}@verify.test`, role: 'member' },
    { id: editor, email: `editor-${editor}@verify.test`, role: 'member' },
  ]);
  await db.insert(schema.tabs).values([
    { id: board, name: 'verify-board-states', type: 'normal', createdBy: admin },
    { id: boardDefault, name: 'verify-board-states default', type: 'normal', createdBy: admin },
    { id: boardLeads, name: 'verify-board-states leads', type: 'normal', createdBy: admin },
  ]);
  for (const b of [board, boardDefault, boardLeads]) await seedBoardStates(db, b);
  await db.insert(schema.boardMembers).values([
    { tabId: board, userId: admin, role: 'admin' },
    { tabId: board, userId: editor, role: 'editor' },
    { tabId: boardDefault, userId: admin, role: 'admin' },
    { tabId: boardLeads, userId: admin, role: 'admin' },
  ]);
  await db.insert(schema.tasks).values([
    { id: taskA, homeTabId: board, text: 'A', status: 'todo', createdBy: admin, rank: 'a0' },
    { id: taskB, homeTabId: board, text: 'B', status: 'todo', createdBy: admin, rank: 'a1' },
    { id: taskTrashed, homeTabId: board, text: 'T', status: 'todo', createdBy: admin, rank: 'a2', deletedAt: new Date() },
  ]);
}

async function cleanup(): Promise<void> {
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.actorId, [admin, editor]));
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [board, boardDefault, boardLeads])); // cascades tasks, states, members, events
  await db.delete(schema.users).where(inArray(schema.users.id, [admin, editor])); // cascades tokens, sessions
}

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
registerAuditHook(app);
await app.register(taskRoutes);
await app.register(boardStateRoutes);

const statusOf = async (id: string) => (await db.select({ s: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, id)))[0]?.s;

try {
  await seed();
  const adminCookie = { [SESSION_COOKIE]: app.signCookie(await createSession(admin)) };
  const editorCookie = { [SESSION_COOKIE]: app.signCookie(await createSession(editor)) };
  const as = (cookies: Record<string, string>) => (method: string, url: string, payload?: object) =>
    app.inject({ method: method as 'GET', url, cookies, ...(payload ? { payload } : {}) });
  const A = as(adminCookie);
  const E = as(editorCookie);
  const S = `/api/tabs/${board}/states`;

  console.log('task writes');
  const nope = await E('PATCH', `/api/tasks/${taskA}`, { status: 'nope' });
  const nj = nope.json() as any;
  check('PATCH an unknown status -> 400 with the valid list', nope.statusCode === 400 && nj.error === 'unknown_status' && nj.valid.length === 6 && nj.valid[0].key === 'todo', nope.body);
  check('PATCH a known status -> 200', (await E('PATCH', `/api/tasks/${taskA}`, { status: 'in_progress' })).statusCode === 200 && (await statusOf(taskA)) === 'in_progress');
  const fresh = nanoid();
  check('PUT with no status starts at the first open state', (await E('PUT', `/api/tasks/${fresh}`, { homeTabId: board, text: 'new' })).statusCode === 200 && (await statusOf(fresh)) === 'todo');
  check('PUT an unknown status -> 400', (await E('PUT', `/api/tasks/${nanoid()}`, { homeTabId: board, text: 'x', status: 'nope' })).statusCode === 400);

  console.log('editing');
  const made = await A('POST', S, { label: 'Contacted', category: 'active', description: 'We reached out.' });
  const contacted = (made.json() as any).state;
  check('create -> 201, s_ key, category default color, appended', made.statusCode === 201 && /^s_.{8}$/.test(contacted.key) && contacted.color === 'blue' && contacted.position === 6, made.body);
  check('the label clash is refused, case-insensitively', (await A('POST', S, { label: '  contacted ', category: 'open' })).statusCode === 400);
  check('a label over 40 characters is refused', (await A('POST', S, { label: 'x'.repeat(41), category: 'open' })).statusCode === 400);
  check('an editor cannot edit states -> 403', (await E('POST', S, { label: 'Nope', category: 'open' })).statusCode === 403);

  const pat = newToken(PAT_PREFIX);
  await db.insert(schema.personalAccessTokens).values({
    id: nanoid(), userId: admin, label: 'verify', tokenHash: pat.hash, scopes: ['tasks', 'comments', 'boards'],
    allBoards: true, tabIds: [], expiresAt: new Date(Date.now() + 86_400_000),
  });
  const viaPat = await app.inject({ method: 'POST', url: S, headers: { authorization: `Bearer ${pat.token}` }, payload: { label: 'ByToken', category: 'open' } });
  check("a PAT is refused, even its admin owner's", viaPat.statusCode === 403, viaPat.statusCode);

  for (let i = 7; i < MAX_STATES; i++) await A('POST', S, { label: `Extra ${i}`, category: 'waiting' });
  check(`the cap of ${MAX_STATES}`, (await A('POST', S, { label: 'One too many', category: 'waiting' })).statusCode === 400);

  const hideDone = await A('PATCH', `${S}/done`, { hidden: true });
  check('hiding the last done state -> 409 required_category', hideDone.statusCode === 409 && (hideDone.json() as any).category === 'done', hideDone.body);
  check('re-categorizing the last open state -> 409', (await A('PATCH', `${S}/todo`, { category: 'active' })).statusCode === 409);
  check('deleting the last done state -> 409', (await A('DELETE', `${S}/done`)).statusCode === 409);
  const rename = await A('PATCH', `${S}/${contacted.key}`, { label: 'Reached', color: 'teal' });
  check('rename and recolor -> 200', rename.statusCode === 200 && (rename.json() as any).state.label === 'Reached');

  console.log('history');
  await E('PATCH', `/api/tasks/${taskB}`, { status: contacted.key });
  await new Promise((r) => setTimeout(r, 300)); // audit rows are written fire-and-forget
  const rows = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetId, taskB), eq(schema.auditLog.actorId, editor)));
  const change = (rows.at(-1)?.payload as any)?.changes?.find((c: any) => c.field === 'status');
  check('a status change stores the labels at the time', change?.fromLabel === 'Todo' && change?.toLabel === 'Reached', change);
  const stateEvents = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.scopeId, board), eq(schema.auditLog.action, 'board_state_change')));
  check('state edits are on the board history', stateEvents.length >= 2 && stateEvents.some((e) => (e.payload as any).op === 'create'), stateEvents.length);

  console.log('reorder');
  const keys = (await db.select({ key: schema.boardStates.key }).from(schema.boardStates).where(eq(schema.boardStates.tabId, board))).map((r) => r.key);
  check('reorder with a missing key -> 400', (await A('PUT', `${S}/order`, { keys: keys.slice(1) })).statusCode === 400);
  const reversed = [...keys].reverse();
  const ro = await A('PUT', `${S}/order`, { keys: reversed });
  check('reorder rewrites positions 0..n', ro.statusCode === 200 && (ro.json() as any).states.map((s: any) => s.key).join() === reversed.join(), ro.body);

  console.log('delete');
  await db.update(schema.tasks).set({ status: contacted.key }).where(eq(schema.tasks.id, taskTrashed));
  await db.insert(schema.events).values({ id: event, tabId: board, title: 'standup', filter: { statuses: [contacted.key, 'todo'] } });
  const noMove = await A('DELETE', `${S}/${contacted.key}`);
  check('deleting a used state without moveTo -> 400 with the count (Trash included)', noMove.statusCode === 400 && (noMove.json() as any).count === 2, noMove.body);
  const del = await A('DELETE', `${S}/${contacted.key}`, { moveTo: 'in_progress' });
  check('delete with moveTo -> 200', del.statusCode === 200 && (del.json() as any).movedTasks === 2, del.body);
  check('...the tasks moved, Trash included', (await statusOf(taskB)) === 'in_progress' && (await statusOf(taskTrashed)) === 'in_progress');
  const tomb = (await db.select().from(schema.boardStates).where(and(eq(schema.boardStates.tabId, board), eq(schema.boardStates.key, contacted.key))))[0];
  check('...and the state is a tombstone', !!tomb?.deletedAt);
  const ev = (await db.select({ f: schema.events.filter }).from(schema.events).where(eq(schema.events.id, event)))[0];
  check("...and left the meeting's status filter", JSON.stringify((ev?.f as any)?.statuses) === '["todo"]', ev?.f);
  check('a deleted state is gone from the list', !(del.json() as any).states.some((s: any) => s.key === contacted.key));

  await db.update(schema.tasks).set({ status: 'todo' }).where(eq(schema.tasks.id, taskA));
  const stale = await E('PATCH', `/api/tasks/${taskA}`, { status: contacted.key });
  check('a later PATCH with the deleted key stores the remapped key and says so', stale.statusCode === 200 && (stale.json() as any).status !== contacted.key && (await statusOf(taskA)) === (stale.json() as any).status, stale.body);
  check('...a state of the same category', (await statusOf(taskA)) === 'in_progress', await statusOf(taskA));
  const unusedKey = ((del.json() as any).states as any[]).find((s) => s.label === 'Extra 7').key;
  check('deleting an unused state needs no moveTo', (await A('DELETE', `${S}/${unusedKey}`)).statusCode === 200);

  console.log('move');
  const L = `/api/tabs/${boardLeads}/states`;
  const contactedL = ((await A('POST', L, { label: 'Contacted', category: 'active' })).json() as any).state.key;
  const wonL = ((await A('POST', L, { label: 'Won', category: 'done' })).json() as any).state.key;
  await db.insert(schema.tasks).values([
    { id: lead, homeTabId: boardLeads, text: 'lead', status: contactedL, createdBy: admin, rank: 'a0' },
    { id: leadKid, homeTabId: boardLeads, text: 'kid', status: wonL, parentTaskId: lead, createdBy: admin, rank: 'a0' },
    { id: plain, homeTabId: boardDefault, text: 'plain', status: 'in_review', createdBy: admin, rank: 'a0' },
  ]);
  const moveTo = (id: string, payload: object) => A('POST', `/api/tasks/${id}/move`, payload);
  const plainMove = await moveTo(plain, { toTabId: boardLeads });
  check('a move between boards that share the key needs no mapping', plainMove.statusCode === 200 && (await statusOf(plain)) === 'in_review', plainMove.body);
  const asked = await moveTo(lead, { toTabId: boardDefault });
  const aj = asked.json() as any;
  check('a move with states the destination lacks -> 409 listing only those', asked.statusCode === 409 && aj.error === 'states_unmapped'
    && aj.unmapped.map((u: any) => u.label).sort().join() === 'Contacted,Won' && aj.options.length === 6, asked.body);
  check('a mapping to a key the destination lacks -> 400', (await moveTo(lead, { toTabId: boardDefault, states: { [contactedL]: 'nope', [wonL]: 'done' } })).statusCode === 400);
  const mapped = await moveTo(lead, { toTabId: boardDefault, states: { [contactedL]: 'in_progress', [wonL]: 'done' } });
  check('with a mapping the subtree moves and takes the mapped states', mapped.statusCode === 200 && (await statusOf(lead)) === 'in_progress' && (await statusOf(leadKid)) === 'done', mapped.body);
  await new Promise((r) => setTimeout(r, 300));
  const moveRow = (await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetId, lead), eq(schema.auditLog.action, 'task_move'))))[0];
  const sc = (moveRow?.payload as any)?.stateChanges ?? [];
  check('the move audit row lists the state changes', sc.length === 2 && sc.some((c: any) => c.fromLabel === 'Won' && c.toLabel === 'Done' && c.count === 1), sc);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  await app.close();
  await pool.end();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall board-states checks passed');
