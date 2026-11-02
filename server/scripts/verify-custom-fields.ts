/* eslint-disable @typescript-eslint/no-explicit-any -- these scripts probe untyped JSON responses */
// End-to-end check of CUSTOM_FIELDS_PLAN.md: create-only task writes (P1), custom fields (P2), board
// templates (P3) and delete forever (P5). Runs against the dev DB in throwaway users and boards that
// it cleans up.
//
//   npm run verify:custom-fields

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

process.env.SESSION_SECRET ??= 'verify-custom-fields-secret-not-used-in-production';

const { db, pool, schema } = await import('../db/client.ts');
const { newToken } = await import('../auth/agent.ts');
const { PAT_PREFIX } = await import('../auth/pat.ts');
const { createSession, SESSION_COOKIE } = await import('../auth/session.ts');
const { registerAuditHook } = await import('../lib/audit.ts');
const { taskRoutes } = await import('../routes/tasks.ts');
const { tabRoutes } = await import('../routes/tabs.ts');
const { boardFieldRoutes } = await import('../routes/boardFields.ts');
const { seedBoardStates } = await import('../lib/boardStates.ts');
const { MAX_FIELDS } = await import('../../shared/fields.ts');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 300)); // audit rows are written fire-and-forget

const [admin, editor, board, other, project] = Array.from({ length: 5 }, () => nanoid());
const madeBoards: string[] = [board, other];

async function seed(): Promise<void> {
  await db.insert(schema.users).values([
    { id: admin, email: `admin-${admin}@verify.test`, role: 'member' },
    { id: editor, email: `editor-${editor}@verify.test`, role: 'member' },
  ]);
  await db.insert(schema.projects).values({ id: project, userId: admin, name: 'verify', color: 'grey', position: 0 });
  await db.insert(schema.tabs).values([
    { id: board, name: 'verify-custom-fields', type: 'normal', createdBy: admin },
    { id: other, name: 'verify-custom-fields other', type: 'normal', createdBy: admin },
  ]);
  for (const b of [board, other]) await seedBoardStates(db, b);
  await db.insert(schema.boardMembers).values([
    { tabId: board, userId: admin, role: 'admin' },
    { tabId: board, userId: editor, role: 'editor' },
    { tabId: other, userId: admin, role: 'admin' },
  ]);
}

async function cleanup(): Promise<void> {
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.actorId, [admin, editor]));
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, madeBoards)); // cascades tasks, fields, states, members
  await db.delete(schema.users).where(inArray(schema.users.id, [admin, editor])); // cascades projects, tokens, sessions
}

const app = Fastify();
await app.register(cookie, { secret: process.env.SESSION_SECRET! });
registerAuditHook(app);
await app.register(taskRoutes);
await app.register(tabRoutes);
await app.register(boardFieldRoutes);

const row = async (id: string) => (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0];

try {
  await seed();
  const adminCookie = { [SESSION_COOKIE]: app.signCookie(await createSession(admin)) };
  const editorCookie = { [SESSION_COOKIE]: app.signCookie(await createSession(editor)) };
  const as = (cookies: Record<string, string>) => (method: string, url: string, payload?: object) =>
    app.inject({ method: method as 'GET', url, cookies, ...(payload ? { payload } : {}) });
  const A = as(adminCookie);
  const E = as(editorCookie);
  const F = `/api/tabs/${board}/fields`;

  console.log('field definitions');
  const site = await A('POST', F, { label: 'Website', type: 'url' });
  check('create -> 201 with a slug key', site.statusCode === 201 && (site.json() as any).field.key === 'website', site.body);
  for (const [label, type] of [['Email', 'email'], ['Phone', 'phone'], ['Fit score', 'number'], ['Notes', 'text']]) await A('POST', F, { label, type });
  const listed = (await A('POST', F, { label: 'Place ID', type: 'text', key: 'place_id' })).json() as any;
  check('an explicit key is kept', listed.field?.key === 'place_id', listed);
  check('the score field got `fit_score`', listed.fields.some((f: any) => f.key === 'fit_score'), listed.fields);
  check('a clashing label is refused', (await A('POST', F, { label: 'website', type: 'text' })).statusCode === 400);
  check('an unknown type is refused', (await A('POST', F, { label: 'Odd', type: 'date' })).statusCode === 400);
  check('an editor cannot add fields -> 403', (await E('POST', F, { label: 'Nope', type: 'text' })).statusCode === 403);

  const pat = newToken(PAT_PREFIX);
  await db.insert(schema.personalAccessTokens).values({
    id: nanoid(), userId: admin, label: 'verify', tokenHash: pat.hash, scopes: ['tasks', 'boards'],
    allBoards: true, tabIds: [], expiresAt: new Date(Date.now() + 86_400_000),
  });
  const T = (method: string, url: string, payload?: object) =>
    app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${pat.token}` }, ...(payload ? { payload } : {}) });
  check("a PAT can't add fields, even its admin owner's", (await T('POST', F, { label: 'ByToken', type: 'text' })).statusCode === 403);

  console.log('values');
  const t1 = nanoid();
  await E('PUT', `/api/tasks/${t1}`, { homeTabId: board, text: 'Bright Smile Dental' });
  const good = await E('PATCH', `/api/tasks/${t1}`, { fields: { website: 'https://brightsmile.co.uk', phone: '0117 123 4567', fit_score: 8 } });
  check('valid values -> 200 and stored', good.statusCode === 200 && (await row(t1)).fields.fit_score === 8, good.body);
  const bad: [string, unknown][] = [['website', 'javascript:alert(1)'], ['website', 'not a url'], ['email', 'two@@at'], ['phone', 'call me'], ['fit_score', '8'], ['notes', 'x'.repeat(501)]];
  for (const [key, value] of bad) {
    const r = await E('PATCH', `/api/tasks/${t1}`, { fields: { [key]: value } });
    check(`invalid ${key} ${JSON.stringify(value).slice(0, 24)} -> 400 invalid_field`, r.statusCode === 400 && (r.json() as any).error === 'invalid_field' && (r.json() as any).key === key, r.body);
  }
  const unknown = await E('PATCH', `/api/tasks/${t1}`, { fields: { tiktok: 'x' } });
  check('an unknown key -> 400 unknown_field with the valid list', unknown.statusCode === 400 && (unknown.json() as any).error === 'unknown_field' && (unknown.json() as any).valid.length === 6, unknown.body);
  await E('PATCH', `/api/tasks/${t1}`, { fields: { email: 'hello@brightsmile.co.uk', phone: null } });
  const merged = (await row(t1)).fields;
  check('a write merges per key and null removes', merged.email === 'hello@brightsmile.co.uk' && merged.website === 'https://brightsmile.co.uk' && !('phone' in merged), merged);
  await E('PATCH', `/api/tasks/${t1}`, { fields: { notes: '   ' } });
  check('a blank string removes, like null', !('notes' in (await row(t1)).fields));
  await E('PUT', `/api/tasks/${t1}`, { homeTabId: board, text: 'Bright Smile Dental, Clifton' });
  check('a PUT without fields keeps them (D6)', (await row(t1)).fields.website === 'https://brightsmile.co.uk');

  await settle();
  const trail = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.targetId, t1), eq(schema.auditLog.actorId, editor)));
  const fieldChange = trail.flatMap((r) => (r.payload as any)?.changes ?? []).find((c: any) => c.field === 'fields.email');
  check('a field change is audited per key with its label', fieldChange?.label === 'Email' && fieldChange?.to === 'hello@brightsmile.co.uk', fieldChange);

  console.log('deleted field');
  await A('DELETE', `${F}/notes`);
  check('a deleted key can no longer be written', (await E('PATCH', `/api/tasks/${t1}`, { fields: { notes: 'x' } })).statusCode === 400);
  const again = (await A('POST', F, { label: 'Notes', type: 'text' })).json() as any;
  check("a deleted key is never reused (the new field isn't `notes`)", again.field?.key && again.field.key !== 'notes', again);
  await A('DELETE', `${F}/${again.field.key}`);

  console.log('cap');
  for (let i = 0; i < MAX_FIELDS - 6; i++) await A('POST', F, { label: `Extra ${i}`, type: 'text' });
  check(`the cap of ${MAX_FIELDS}`, (await A('POST', F, { label: 'One too many', type: 'text' })).statusCode === 400);

  console.log('create-only POST');
  const lead = `pl_${nanoid()}`;
  const post = (payload: object) => T('POST', '/api/tasks', { id: lead, homeTabId: board, text: 'Lead', ...payload });
  const created = await post({ fields: { website: 'https://lead.example' } });
  check('a new id -> 201 created', created.statusCode === 201 && (created.json() as any).created === true, created.body);
  await E('PATCH', `/api/tasks/${lead}`, { assigneeId: editor, text: 'Lead, worked on' });
  const resend = await post({ text: 'Lead again', fields: { website: 'https://other.example' } });
  check('re-sending -> 200 created:false', resend.statusCode === 200 && (resend.json() as any).created === false && (resend.json() as any).deleted === false, resend.body);
  const kept = await row(lead);
  check('...and overwrote nothing', kept.text === 'Lead, worked on' && kept.assigneeId === editor && kept.fields.website === 'https://lead.example', kept);
  await E('DELETE', `/api/tasks/${lead}`);
  const trashed = await post({});
  check('re-sending a trashed one -> created:false, deleted:true', (trashed.json() as any).deleted === true, trashed.body);
  check('...and it stays trashed', (await row(lead)).deletedAt != null);
  const elsewhere = await A('POST', '/api/tasks', { id: lead, homeTabId: other, text: 'Lead' });
  check('the same id on another board -> 409 id_taken', elsewhere.statusCode === 409 && (elsewhere.json() as any).error === 'id_taken', elsewhere.body);
  check('a bad field value refuses the create', (await T('POST', '/api/tasks', { id: nanoid(), homeTabId: board, text: 'x', fields: { email: 'nope' } })).statusCode === 400);

  console.log('move');
  await A('POST', `/api/tabs/${other}/fields`, { label: 'Website', type: 'url' });
  await A('POST', `/api/tabs/${other}/fields`, { label: 'Email', type: 'text' }); // same key, other type
  const mover = nanoid();
  await A('PUT', `/api/tasks/${mover}`, { homeTabId: board, text: 'mover' });
  await A('PATCH', `/api/tasks/${mover}`, { fields: { website: 'https://m.example', email: 'm@m.example', fit_score: 3 } });
  const moved = await A('POST', `/api/tasks/${mover}/move`, { toTabId: other });
  const mf = (await row(mover)).fields;
  check('a move keeps same key+type, drops the rest, and counts them', moved.statusCode === 200 && (moved.json() as any).droppedFields === 2
    && mf.website === 'https://m.example' && !('email' in mf) && !('fit_score' in mf), { body: moved.body, mf });

  console.log('board templates');
  const tpl = nanoid();
  madeBoards.push(tpl);
  const template = {
    id: tpl, projectId: project, name: 'Leads · Dentists Bristol', position: 0,
    states: [
      { key: 'new', label: 'New', category: 'open' },
      { key: 'contacted', label: 'Contacted', category: 'active' },
      { key: 'won', label: 'Won', category: 'done' },
      { key: 'do_not_contact', label: 'Do not contact', category: 'closed' },
    ],
    fields: [{ key: 'place_id', label: 'Place ID', type: 'text' }, { label: 'Website', type: 'url' }],
  };
  const noDone = await T('POST', '/api/tabs', { ...template, id: nanoid(), states: template.states.filter((s) => s.category !== 'done') });
  check('a template without a done state -> 400, no board', noDone.statusCode === 400 && (noDone.json() as any).error === 'required_category', noDone.body);
  const dupKey = await T('POST', '/api/tabs', { ...template, id: nanoid(), fields: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }] });
  check('duplicate field keys -> 400', dupKey.statusCode === 400, dupKey.body);
  const tooMany = await T('POST', '/api/tabs', { ...template, id: nanoid(), fields: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({ label: `F${i}`, type: 'text' })) });
  check(`${MAX_FIELDS + 1} fields -> 400`, tooMany.statusCode === 400, tooMany.body);
  const tplMade = await T('POST', '/api/tabs', template);
  const states = await db.select().from(schema.boardStates).where(eq(schema.boardStates.tabId, tpl));
  const fields = await db.select().from(schema.boardFields).where(eq(schema.boardFields.tabId, tpl));
  check('a valid template -> exactly its states and fields', tplMade.statusCode === 201 && states.map((s) => s.key).sort().join() === 'contacted,do_not_contact,new,won'
    && fields.map((f) => f.key).sort().join() === 'place_id,website', { body: tplMade.body, states: states.length, fields: fields.length });
  const dnc = `pl_${nanoid()}`;
  await T('POST', '/api/tasks', { id: dnc, homeTabId: tpl, text: 'No thanks Ltd', fields: { place_id: 'ChIJ123' } });
  await A('PATCH', `/api/tasks/${dnc}`, { status: 'do_not_contact' });
  const dncAgain = await T('POST', '/api/tasks', { id: dnc, homeTabId: tpl, text: 'No thanks Ltd' });
  check('D14: a do-not-contact lead re-sent stays put', (dncAgain.json() as any).created === false && (await row(dnc)).status === 'do_not_contact', dncAgain.body);

  console.log('delete forever');
  const doomed = nanoid();
  const kid = nanoid();
  await A('PUT', `/api/tasks/${doomed}`, { homeTabId: board, text: 'John Smith Plumbing' });
  await A('PUT', `/api/tasks/${kid}`, { homeTabId: board, text: 'call John', parentTaskId: doomed });
  await A('PATCH', `/api/tasks/${doomed}`, { fields: { phone: '07700 900123' }, assigneeId: editor });
  await db.insert(schema.taskComments).values({ id: nanoid(), taskId: kid, tabId: board, authorId: admin, body: 'his mobile is 07700 900123', mentions: [], lastBody: 'x' });
  const docId = nanoid();
  await db.insert(schema.documents).values({ id: docId, tabId: board, taskId: doomed, storageKey: `verify/${docId}`, filename: 'quote.pdf', mime: 'application/pdf', size: 1, uploadedBy: admin });
  check('delete forever on a live task -> 409 not_in_trash', (await A('DELETE', `/api/tasks/${doomed}/forever`)).statusCode === 409);
  await A('DELETE', `/api/tasks/${doomed}`);
  check('an editor cannot delete forever -> 403', (await E('DELETE', `/api/tasks/${doomed}/forever`)).statusCode === 403);
  check('a PAT cannot delete forever', (await T('DELETE', `/api/tasks/${doomed}/forever`)).statusCode === 403);
  await settle();
  const purge = await A('DELETE', `/api/tasks/${doomed}/forever`);
  const pj = purge.json() as any;
  check('delete forever -> 200 with both ids and the unlinked document', purge.statusCode === 200 && pj.deleted.length === 2 && pj.documents[0]?.name === 'quote.pdf', purge.body);
  check('...the rows are gone', !(await row(doomed)) && !(await row(kid)));
  check('...their comments are gone', (await db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, kid))).length === 0);
  check('...the notifications that quoted it are gone', (await db.select().from(schema.notifications).where(eq(schema.notifications.taskId, doomed))).length === 0);
  check('...the document stays, unlinked', (await db.select().from(schema.documents).where(eq(schema.documents.id, docId)))[0]?.taskId === null);
  await settle();
  const left = await db.select().from(schema.auditLog).where(inArray(schema.auditLog.targetId, [doomed, kid]));
  const text = JSON.stringify(left.map((r) => r.payload));
  check('...history keeps no title, phone or comment text', !/John|07700/.test(text), text);
  check('...but still says which fields changed', left.some((r) => (r.payload as any)?.changes?.some((c: any) => c.field === 'fields.phone' && c.label === 'Phone' && !('to' in c))), text);
  check('...and one task_purge row with no title', left.filter((r) => r.action === 'task_purge').length === 1 && (left.find((r) => r.action === 'task_purge')?.payload as any)?.taskCount === 2);
  const reborn = await T('POST', '/api/tasks', { id: doomed, homeTabId: board, text: 'back' });
  check('the freed id can be created again', reborn.statusCode === 201, reborn.body);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  await app.close();
  await pool.end();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall custom-fields checks passed');
