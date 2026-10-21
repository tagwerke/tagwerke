/* eslint-disable @typescript-eslint/no-explicit-any -- these scripts probe untyped JSON responses */
// End-to-end check of personal access tokens (PAT_PLAN.md): bearer auth, deny-by-default, board
// reach, scopes, token management, and the audit stamp. Runs against the dev DB in throwaway
// users and boards that it cleans up.
//
//   npm run verify:pat

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

process.env.SESSION_SECRET ??= 'verify-pat-secret-not-used-in-production';

const { db, pool, schema } = await import('../db/client.ts');
const { newToken } = await import('../auth/agent.ts');
const { PAT_PREFIX } = await import('../auth/pat.ts');
const { createSession, SESSION_COOKIE } = await import('../auth/session.ts');
const { registerAuditHook } = await import('../lib/audit.ts');
const { stateRoutes } = await import('../routes/state.ts');
const { tabRoutes } = await import('../routes/tabs.ts');
const { taskRoutes } = await import('../routes/tasks.ts');
const { sprintRoutes } = await import('../routes/sprints.ts');
const { commentRoutes } = await import('../routes/comments.ts');
const { memberRoutes } = await import('../routes/members.ts');
const { historyRoutes } = await import('../routes/history.ts');
const { tokenRoutes } = await import('../routes/tokens.ts');
const { secretRoutes } = await import('../routes/secrets.ts');
const { accountSudoRoutes } = await import('../routes/sudo.ts');
const { adminRoutes } = await import('../routes/admin.ts');
const { authRoutes } = await import('../auth/routes.ts');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

// owner: the token owner. other: a second person (comment author, and the owner of a board the
// owner is not on). gone: an owner who gets deactivated.
const [owner, other, gone, boardA, boardB, boardC, boardX, project, taskA, taskB, taskC, sprintA] = Array.from({ length: 12 }, () => nanoid());
const created: string[] = []; // boards made through the API during the run

const mint = async (userId: string, o: Partial<typeof schema.personalAccessTokens.$inferInsert> = {}) => {
  const t = newToken(PAT_PREFIX);
  await db.insert(schema.personalAccessTokens).values({
    id: nanoid(), userId, label: 'verify', tokenHash: t.hash, scopes: ['tasks', 'comments', 'boards'],
    allBoards: false, tabIds: [boardA], expiresAt: new Date(Date.now() + 86_400_000), ...o,
  });
  return t.token;
};

async function seed(): Promise<void> {
  await db.insert(schema.users).values([
    { id: owner, email: `owner-${owner}@verify.test`, role: 'member' },
    { id: other, email: `other-${other}@verify.test`, role: 'member' },
    { id: gone, email: `gone-${gone}@verify.test`, role: 'member' },
  ]);
  await db.insert(schema.projects).values({ id: project, userId: owner, name: 'verify', color: '#888888', position: 0 });
  await db.insert(schema.tabs).values([
    { id: boardA, name: 'verify-pat A', type: 'normal', createdBy: owner },
    { id: boardB, name: 'verify-pat B', type: 'normal', createdBy: owner },
    { id: boardC, name: 'verify-pat C (viewer)', type: 'normal', createdBy: other },
    { id: boardX, name: 'verify-pat X (not mine)', type: 'normal', createdBy: other },
  ]);
  await db.insert(schema.boardMembers).values([
    { tabId: boardA, userId: owner, role: 'admin', categoryId: project, position: 0 },
    { tabId: boardA, userId: other, role: 'editor' },
    { tabId: boardB, userId: owner, role: 'admin', categoryId: project, position: 1 },
    { tabId: boardC, userId: owner, role: 'viewer', categoryId: project, position: 2 },
    { tabId: boardC, userId: other, role: 'admin' },
    { tabId: boardX, userId: other, role: 'admin' },
  ]);
  await db.insert(schema.sprints).values({ id: sprintA, tabId: boardA, label: 'verify sprint', startsAt: '2026-01-05', endsAt: '2026-01-11', isCurrent: true });
  await db.insert(schema.tasks).values([
    { id: taskA, homeTabId: boardA, text: 'Task on A', status: 'todo', createdBy: owner, rank: 'a0' },
    { id: taskB, homeTabId: boardB, text: 'Task on B', status: 'todo', createdBy: owner, rank: 'a0' },
    { id: taskC, homeTabId: boardC, text: 'Task on C', status: 'todo', createdBy: other, rank: 'a0' },
  ]);
}

async function cleanup(): Promise<void> {
  const users = [owner, other, gone];
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.actorId, users));
  await db.delete(schema.notifications).where(inArray(schema.notifications.userId, users));
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [boardA, boardB, boardC, boardX, ...created])); // cascades tasks, comments, members
  await db.delete(schema.users).where(inArray(schema.users.id, users)); // cascades tokens, sessions
  await db.delete(schema.projects).where(eq(schema.projects.id, project));
}

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
registerAuditHook(app);
for (const r of [authRoutes, stateRoutes, tabRoutes, taskRoutes, sprintRoutes, commentRoutes, memberRoutes, historyRoutes, tokenRoutes, secretRoutes, accountSudoRoutes, adminRoutes]) {
  await app.register(r);
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (method: string, url: string, token?: string, payload?: object, cookies?: Record<string, string>) =>
  app.inject({ method: method as 'GET', url, headers: token ? bearer(token) : {}, ...(cookies ? { cookies } : {}), ...(payload ? { payload } : {}) });
const code = async (p: ReturnType<typeof call>) => (await p).statusCode;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  await seed();
  const sid = await createSession(owner);
  const ownerCookie = { [SESSION_COOKIE]: app.signCookie(sid) };
  const otherCookie = { [SESSION_COOKIE]: app.signCookie(await createSession(other)) };

  const tokA = await mint(owner); // all write scopes, board A only
  const tokAll = await mint(owner, { allBoards: true, tabIds: [] });
  const tokRead = await mint(owner, { scopes: [] });
  const tokTasks = await mint(owner, { scopes: ['tasks'] });
  const tokComments = await mint(owner, { scopes: ['comments'] });
  const tokBoards = await mint(owner, { scopes: ['boards'], tabIds: [boardA, boardB] });

  console.log('authentication');
  check('no token -> 401', (await code(call('GET', '/api/state'))) === 401);
  check('garbage pat token -> 401', (await code(call('GET', '/api/state', `${PAT_PREFIX}nope`))) === 401);
  const expired = await mint(owner, { expiresAt: new Date(Date.now() - 1000) });
  check('expired token -> 401', (await code(call('GET', '/api/state', expired))) === 401);
  const revoked = await mint(owner, { revokedAt: new Date() });
  check('revoked token -> 401', (await code(call('GET', '/api/state', revoked))) === 401);
  const goneTok = await mint(gone);
  check('live token works before the owner is deactivated', (await code(call('GET', '/api/state', goneTok))) === 200);
  await db.update(schema.users).set({ deactivatedAt: new Date() }).where(eq(schema.users.id, gone));
  check('deactivated owner -> 401', (await code(call('GET', '/api/state', goneTok))) === 401);
  check('a bad token is not rescued by a valid cookie', (await code(call('GET', '/api/state', `${PAT_PREFIX}nope`, undefined, ownerCookie))) === 401);
  const asOwner = (await call('GET', '/api/state', tokA, undefined, otherCookie)).json() as any;
  check("a bearer wins over the cookie: acts as the token's owner, not the cookie's", Object.keys(asOwner.tabs ?? {}).includes(boardA) && !Object.keys(asOwner.tabs).includes(boardX));
  check('token last-used is stamped', await (async () => {
    await sleep(150);
    const r = (await db.select().from(schema.personalAccessTokens).where(eq(schema.personalAccessTokens.userId, owner)).limit(50)).find((t) => t.lastUsedAt);
    return !!r;
  })());

  console.log('deny by default (every scope ticked, every board)');
  check('GET /api/tokens -> 403', (await code(call('GET', '/api/tokens', tokAll))) === 403);
  check('POST /api/tokens -> 403', (await code(call('POST', '/api/tokens', tokAll, { label: 'x', scopes: [], allBoards: true, boardIds: [], days: 30 }))) === 403);
  check('DELETE /api/tokens/:id -> 403', (await code(call('DELETE', '/api/tokens/whatever', tokAll))) === 403);
  check('secrets list -> 403', (await code(call('GET', `/api/boards/${boardA}/secrets`, tokAll))) === 403);
  check('sudo grant -> 403', (await code(call('POST', '/api/auth/sudo', tokAll, { password: 'x' }))) === 403);
  check('sudo probe -> 403', (await code(call('GET', '/api/auth/sudo', tokAll))) === 403);
  check('TOTP enroll -> 403', (await code(call('POST', '/api/auth/totp/enroll', tokAll))) === 403);
  check('admin routes are cookie-only -> 401', (await code(call('GET', '/api/admin/users', tokAll))) === 401);
  check('add a member -> 403 (not opted in)', (await code(call('POST', `/api/tabs/${boardA}/members`, tokAll, { email: 'x@y.test', role: 'viewer' }))) === 403);
  check('delete a board -> 403', (await code(call('DELETE', `/api/tabs/${boardB}`, tokAll))) === 403);
  check('bulk delete-orphans -> 403', (await code(call('POST', '/api/tasks/delete-orphans', tokAll, { homeTabId: boardA, keepIds: [] }))) === 403);
  check('reorder boards -> 403', (await code(call('POST', '/api/tabs/reorder', tokAll, { order: [boardA] }))) === 403);
  check('delete a sprint -> 403', (await code(call('DELETE', '/api/sprints/whatever', tokAll))) === 403);

  console.log('board reach');
  check('ticked board -> 200', (await code(call('GET', `/api/tabs/${boardA}/sprints`, tokA))) === 200);
  check('unticked board (mine) -> 404', (await code(call('GET', `/api/tabs/${boardB}/sprints`, tokA))) === 404);
  check("a board I am not on -> 404", (await code(call('GET', `/api/tabs/${boardX}/sprints`, tokAll))) === 404);
  const putOnB = await call('PUT', `/api/tasks/${nanoid()}`, tokA, { homeTabId: boardB, text: 'sneak' });
  check('PUT a new task on an unticked board -> 404', putOnB.statusCode === 404, putOnB.statusCode);
  const rehome = await call('PUT', `/api/tasks/${taskB}`, tokA, { homeTabId: boardA, text: 'pulled in' });
  check('PUT re-homing a task from an unticked board -> 404', rehome.statusCode === 404, rehome.statusCode);
  const stillB = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskB)))[0];
  check('...and the task did not move', stillB?.homeTabId === boardB && stillB.text === 'Task on B');
  check('move to an unticked board -> 404', (await code(call('POST', `/api/tasks/${taskA}/move`, tokA, { toTabId: boardB }))) === 404);
  check('PATCH a task on an unticked board -> 404', (await code(call('PATCH', `/api/tasks/${taskB}`, tokA, { text: 'x' }))) === 404);
  check('PATCH an unticked board -> 404', (await code(call('PATCH', `/api/tabs/${boardB}`, tokA, { name: 'x' }))) === 404);
  check('comment on a task of an unticked board -> 404', (await code(call('POST', `/api/tasks/${taskB}/comments`, tokA, { id: nanoid(), body: 'x' }))) === 404);
  const stateA = (await call('GET', '/api/state', tokA)).json() as any;
  check('/api/state returns only the ticked board', JSON.stringify(Object.keys(stateA.tabs)) === JSON.stringify([boardA]) && stateA.tabOrder.length === 1);
  check('...with only its tasks, members and sprints', Object.values(stateA.tasks).every((t: any) => t.homeTabId === boardA) && Object.keys(stateA.membersByBoard).every((k) => k === boardA) && Object.keys(stateA.sprintsByBoard).every((k) => k === boardA));
  check('...and the owner’s categories (needed to create a board)', Object.keys(stateA.projects).includes(project));
  const stateAll = (await call('GET', '/api/state', tokAll)).json() as any;
  check('allBoards sees every board I am on, and none I am not', [boardA, boardB, boardC].every((b) => b in stateAll.tabs) && !(boardX in stateAll.tabs));

  const newBoard = nanoid();
  created.push(newBoard);
  const make = await call('POST', '/api/tabs', tokA, { id: newBoard, projectId: project, name: 'made by token', position: 9 });
  check('POST /api/tabs through the token -> 201', make.statusCode === 201, make.body);
  check('...the new board joins the token’s list and is reachable', (await code(call('GET', `/api/tabs/${newBoard}/sprints`, tokA))) === 200);
  const later = nanoid();
  created.push(later);
  await call('POST', '/api/tabs', undefined, { id: later, projectId: project, name: 'made later', position: 10 }, ownerCookie);
  check('allBoards reaches a board created after the token', (await code(call('GET', `/api/tabs/${later}/sprints`, tokAll))) === 200);
  check('a fixed list does not', (await code(call('GET', `/api/tabs/${later}/sprints`, tokBoards))) === 404);
  check('the owner’s live role still applies: editor write on a board I only view -> 403', (await code(call('PUT', `/api/tasks/${taskC}`, tokAll, { homeTabId: boardC, text: 'x' }))) === 403);
  check('...but reading it works', (await code(call('GET', `/api/tabs/${boardC}/sprints`, tokAll))) === 200);

  console.log('settings');
  check('a settings patch through a token -> 403', (await code(call('PATCH', `/api/tabs/${boardA}`, tokA, { settings: { restrictDelete: 'admin' } }))) === 403);
  check('a rename through a token -> 200', (await code(call('PATCH', `/api/tabs/${boardA}`, tokA, { name: 'verify-pat A renamed' }))) === 200);
  check('the same settings patch from the owner’s session -> 200', (await code(call('PATCH', `/api/tabs/${boardA}`, undefined, { settings: { restrictDelete: 'admin' } }, ownerCookie))) === 200);
  await call('PATCH', `/api/tabs/${boardA}`, undefined, { settings: { restrictDelete: null } }, ownerCookie);

  console.log('scopes');
  const sprintId = sprintA;
  check('read-only token reads', (await code(call('GET', '/api/state', tokRead))) === 200 && (await code(call('GET', `/api/tabs/${boardA}/members`, tokRead))) === 200);
  check('read-only token cannot write a task -> 403', (await code(call('PATCH', `/api/tasks/${taskA}`, tokRead, { text: 'x' }))) === 403);
  check('read-only token cannot comment -> 403', (await code(call('POST', `/api/tasks/${taskA}/comments`, tokRead, { id: nanoid(), body: 'x' }))) === 403);
  check('read-only token cannot rename a board -> 403', (await code(call('PATCH', `/api/tabs/${boardA}`, tokRead, { name: 'x' }))) === 403);
  check('tasks scope: edit a task -> 200', (await code(call('PATCH', `/api/tasks/${taskA}`, tokTasks, { text: 'edited by token', status: 'in_review' }))) === 200);
  check('tasks scope: create a task -> 200', (await code(call('PUT', `/api/tasks/${nanoid()}`, tokTasks, { homeTabId: boardA, text: 'new via token' }))) === 200);
  check('tasks scope: assign a sprint -> 200', (await code(call('PATCH', `/api/tasks/${taskA}`, tokTasks, { sprintId }))) === 200);
  check('tasks scope: status is just a status (in_review -> done) -> 200', (await code(call('PATCH', `/api/tasks/${taskA}`, tokTasks, { status: 'done' }))) === 200);
  check('tasks scope: cannot comment -> 403', (await code(call('POST', `/api/tasks/${taskA}/comments`, tokTasks, { id: nanoid(), body: 'x' }))) === 403);
  check('tasks scope: cannot rename a board -> 403', (await code(call('PATCH', `/api/tabs/${boardA}`, tokTasks, { name: 'x' }))) === 403);
  const cid = nanoid();
  check('comments scope: comment -> 200', (await code(call('POST', `/api/tasks/${taskA}/comments`, tokComments, { id: cid, body: 'from a token' }))) === 200);
  const viaRow = (await db.select().from(schema.taskComments).where(eq(schema.taskComments.id, cid)))[0];
  check('a comment through a token records the token name', viaRow?.viaLabel === 'verify');
  check('...and the comment payload carries it as `via`', ((await call('GET', `/api/tasks/${taskA}/comments`, tokComments)).json() as any).comments.some((c: any) => c.id === cid && c.via === 'verify'));
  check('comments scope: edit own comment -> 200', (await code(call('PATCH', `/api/comments/${cid}`, tokComments, { body: 'edited' }))) === 200);
  check('comments scope: read the thread -> 200', (await code(call('GET', `/api/tasks/${taskA}/comments`, tokComments))) === 200);
  check('comments scope: cannot edit a task -> 403', (await code(call('PATCH', `/api/tasks/${taskA}`, tokComments, { text: 'x' }))) === 403);
  check('boards scope: rename a sprint -> 200', (await code(call('PATCH', `/api/sprints/${sprintId}`, tokBoards, { label: 'renamed' }))) === 200);
  check('boards scope: cannot edit a task -> 403', (await code(call('PATCH', `/api/tasks/${taskA}`, tokBoards, { text: 'x' }))) === 403);
  check('tasks scope: delete + restore -> 200', (await code(call('DELETE', `/api/tasks/${taskA}`, tokTasks))) === 200 && (await code(call('POST', `/api/tasks/${taskA}/restore`, tokTasks))) === 200);
  check('read: the trash list -> 200', (await code(call('GET', `/api/tabs/${boardA}/trash`, tokRead))) === 200);

  console.log('comment delete is author-only');
  const othersComment = nanoid();
  await db.insert(schema.taskComments).values({ id: othersComment, taskId: taskA, tabId: boardA, authorId: other, body: 'theirs', lastBody: 'theirs', mentions: [] });
  check("a token cannot delete someone else's comment -> 403", (await code(call('DELETE', `/api/comments/${othersComment}`, tokComments))) === 403);
  check("...and neither can the owner's board-admin session -> 403", (await code(call('DELETE', `/api/comments/${othersComment}`, undefined, undefined, ownerCookie))) === 403);
  check('a token can delete its own comment -> 200', (await code(call('DELETE', `/api/comments/${cid}`, tokComments))) === 200);
  check('the author can delete theirs -> 200', (await code(call('DELETE', `/api/comments/${othersComment}`, undefined, undefined, otherCookie))) === 200);

  console.log('audit stamp');
  await sleep(300);
  const rows = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.actorId, owner)));
  const via = (a: string) => rows.some((r) => r.action === a && (r.payload as any)?.via === 'pat' && typeof (r.payload as any)?.tokenId === 'string');
  check('an edit through a token is stamped via=pat', via('PATCH /api/tasks/:id'));
  check('a create through a token is stamped via=pat', via('PUT /api/tasks/:id'));
  check('a comment through a token is stamped via=pat', via('comment_create'));
  check('a delete through a token is stamped via=pat', via('DELETE /api/tasks/:id'));
  const settingsRows = rows.filter((r) => r.action === 'board_settings_change');
  check('a session write is not stamped', settingsRows.length > 0 && settingsRows.every((r) => !(r.payload as any)?.via));

  console.log('token management');
  const body = { label: 'my agent', scopes: ['tasks', 'comments'], allBoards: false, boardIds: [boardA], days: 90 };
  check('create without a step-up -> 401 sudo required', (await call('POST', '/api/tokens', undefined, body, ownerCookie)).json().error === 'sudo required');
  await db.update(schema.sessions).set({ sudoAt: new Date() }).where(eq(schema.sessions.id, sid));
  check('create with an unknown board -> 400', (await code(call('POST', '/api/tokens', undefined, { ...body, boardIds: [boardX] }, ownerCookie))) === 400);
  check('create with a board I am not on, among others -> 400', (await code(call('POST', '/api/tokens', undefined, { ...body, boardIds: [boardA, boardX] }, ownerCookie))) === 400);
  check('create with no expiry -> 400', (await code(call('POST', '/api/tokens', undefined, { ...body, days: undefined }, ownerCookie))) === 400);
  check('create with an arbitrary expiry -> 400', (await code(call('POST', '/api/tokens', undefined, { ...body, days: 9999 }, ownerCookie))) === 400);
  check('create with an unknown scope -> 400', (await code(call('POST', '/api/tokens', undefined, { ...body, scopes: ['approve'] }, ownerCookie))) === 400);
  const made = await call('POST', '/api/tokens', undefined, body, ownerCookie);
  const mj = made.json() as any;
  check('create with a step-up -> 201 and the secret once', made.statusCode === 201 && typeof mj.token === 'string' && mj.token.startsWith(PAT_PREFIX), made.body);
  const stored = (await db.select().from(schema.personalAccessTokens).where(eq(schema.personalAccessTokens.id, mj.id)))[0];
  check('only a hash is stored', !!stored && stored.tokenHash !== mj.token && !JSON.stringify(stored).includes(mj.token));
  check('the new token works', (await code(call('GET', '/api/state', mj.token))) === 200);
  const list = (await call('GET', '/api/tokens', undefined, undefined, ownerCookie)).json() as any;
  check('GET /api/tokens lists it without a hash or secret', list.tokens.some((t: any) => t.id === mj.id) && !JSON.stringify(list).includes('tokenHash') && !JSON.stringify(list).includes(mj.token));
  await sleep(300);
  const note = (await db.select().from(schema.notifications).where(eq(schema.notifications.userId, owner))).find((n) => n.type === 'token_created');
  check('the owner is notified, without the secret', !!note && note.body === 'my agent' && !JSON.stringify(note).includes(mj.token));
  check("another user cannot revoke it -> 404", (await code(call('DELETE', `/api/tokens/${mj.id}`, undefined, undefined, otherCookie))) === 404);
  check('revoke needs no step-up -> 200', (await (async () => {
    await db.update(schema.sessions).set({ sudoAt: null }).where(eq(schema.sessions.id, sid));
    return code(call('DELETE', `/api/tokens/${mj.id}`, undefined, undefined, ownerCookie));
  })()) === 200);
  check('a revoked token -> 401', (await code(call('GET', '/api/state', mj.token))) === 401);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  await app.close();
  await pool.end();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pat checks passed');
