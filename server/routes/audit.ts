// Audit-log visibility: an admin read surface over the append-only audit_log. Browse/filter
// (keyset-paginated) + export (CSV for auditors, NDJSON for SIEM). Read-only; the log is never
// mutated here. See AUTH_IMPLEMENTATION_PLAN.md (audit visibility).
//
// Filtering is a general is / is-not condition list over the row's own fields (the admin board
// clicks a cell value to "show matching" or "exclude"). AND-combined; is-not uses IS DISTINCT FROM
// so excluding a value still keeps null/system rows. Ordering stays fixed (createdAt desc, id
// desc) — the log is inherently time-ordered — so keyset pagination is unaffected by filters.

import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { and, desc, eq, gte, lte, sql, type SQL, type Column } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAdmin, requireSudo } from '../auth/guard.ts';

// The filterable fields → their columns. `actor` = actor_id, `scope` = scope_id (a board/tab).
const FIELD_COLS: Record<string, Column> = {
  actor: schema.auditLog.actorId,
  action: schema.auditLog.action,
  targetType: schema.auditLog.targetType,
  targetId: schema.auditLog.targetId,
  scope: schema.auditLog.scopeId,
  status: schema.auditLog.status,
  method: schema.auditLog.method,
};

interface Condition {
  field: string;
  op: 'is' | 'isnot';
  value: string;
}

interface Filters {
  conditions: Condition[];
  from?: string;
  to?: string;
  category?: string; // 'security' hides the high-volume coarse "METHOD /route" rows
}

/** Parse the JSON `conditions` param defensively: whitelist field/op, cap the count, drop junk. */
function parseConditions(raw?: string): Condition[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Condition[] = [];
  for (const c of arr) {
    if (out.length >= 20) break; // hard cap — a bounded WHERE, not an arbitrary query
    if (!c || typeof c !== 'object') continue;
    const { field, op, value } = c as Record<string, unknown>;
    if (typeof field === 'string' && field in FIELD_COLS && (op === 'is' || op === 'isnot') && typeof value === 'string') {
      out.push({ field, op, value });
    }
  }
  return out;
}

function readFilters(q: Record<string, string | undefined>): Filters {
  return { conditions: parseConditions(q.conditions), from: q.from, to: q.to, category: q.category };
}

/** One condition → SQL. `status` is an integer column, so its value is cast. is-not uses IS
 *  DISTINCT FROM so excluding a value keeps rows where the field is null (system events). */
function condToSql({ field, op, value }: Condition): SQL | null {
  const col = FIELD_COLS[field];
  if (!col) return null;
  const val: string | number = field === 'status' ? Number(value) : value;
  if (field === 'status' && Number.isNaN(val)) return null;
  return op === 'isnot' ? sql`${col} IS DISTINCT FROM ${val}` : sql`${col} IS NOT DISTINCT FROM ${val}`;
}

function conditions(f: Filters): SQL[] {
  const c: SQL[] = [];
  for (const cond of f.conditions) {
    const s = condToSql(cond);
    if (s) c.push(s);
  }
  if (f.from) c.push(gte(schema.auditLog.createdAt, new Date(f.from)));
  if (f.to) c.push(lte(schema.auditLog.createdAt, new Date(f.to)));
  // Coarse mutation rows are written as "<METHOD> <route>" (with a space); named/security
  // events are single snake_case tokens. Exclude the former for the "security" view.
  if (f.category === 'security') c.push(sql`${schema.auditLog.action} NOT LIKE '% %'`);
  return c;
}

// Base select joined to users (actor email) and tabs (scope/board name, for readable "which room").
// Both left joins: a null actor / non-board scope simply yields null.
function rowsQuery() {
  return db
    .select({
      id: schema.auditLog.id,
      actorId: schema.auditLog.actorId,
      actorEmail: schema.users.email,
      action: schema.auditLog.action,
      targetType: schema.auditLog.targetType,
      targetId: schema.auditLog.targetId,
      scopeId: schema.auditLog.scopeId,
      scopeName: schema.tabs.name,
      method: schema.auditLog.method,
      status: schema.auditLog.status,
      createdAt: schema.auditLog.createdAt,
      payload: schema.auditLog.payload,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
    .leftJoin(schema.tabs, eq(schema.tabs.id, schema.auditLog.scopeId));
}

// Keyset cursor over (createdAt desc, id desc).
function decodeCursor(cursor: string): SQL {
  const [ts, id] = Buffer.from(cursor, 'base64').toString('utf8').split('|');
  return sql`(${schema.auditLog.createdAt}, ${schema.auditLog.id}) < (${new Date(ts)}, ${id})`;
}
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64');
}

type Row = Awaited<ReturnType<ReturnType<typeof rowsQuery>['limit']>>[number];
const csvEsc = (v: unknown) => `"${(v == null ? '' : String(v)).replace(/"/g, '""')}"`;
const CSV_HEADER = 'createdAt,actorEmail,actorId,action,targetType,targetId,scopeId,scopeName,method,status,payload';
function csvLine(r: Row): string {
  return [r.createdAt.toISOString(), r.actorEmail, r.actorId, r.action, r.targetType, r.targetId, r.scopeId, r.scopeName, r.method, r.status, r.payload != null ? JSON.stringify(r.payload) : '']
    .map(csvEsc)
    .join(',') + '\n';
}
function ndjsonLine(r: Row): string {
  return JSON.stringify({ ...r, createdAt: r.createdAt.toISOString() }) + '\n';
}

// ── Record preview ────────────────────────────────────────────────────────────────────────
// A read-only snapshot of an audit row's target (or actor/scope), so the admin can see the actual
// record behind an id. Admin+sudo gated, cross-board (unlike the membership-gated per-object
// history route). The record's change list comes from the audit log itself (target_id match), so
// it works for boards the admin isn't a member of, and extends to users/members too.

interface RecordField {
  label: string;
  value: string;
}
interface PreviewRecord {
  type: string;
  id: string;
  title: string;
  deleted: boolean;
  fields: RecordField[];
}

const F = (label: string, value: unknown): RecordField => ({ label, value: value == null || value === '' ? '—' : String(value) });
const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : null);

async function emailOf(id: string | null): Promise<string | null> {
  if (!id) return null;
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u?.email ?? null;
}
async function boardNameOf(id: string | null): Promise<string | null> {
  if (!id) return null;
  const [t] = await db.select({ name: schema.tabs.name }).from(schema.tabs).where(eq(schema.tabs.id, id)).limit(1);
  return t?.name ?? null;
}

async function resolveTask(id: string): Promise<PreviewRecord | null> {
  const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  if (!t) return null;
  const [assignee, reviewer, board] = await Promise.all([emailOf(t.assigneeId), emailOf(t.reviewerId), boardNameOf(t.homeTabId)]);
  return {
    type: 'task', id, deleted: !!t.deletedAt,
    title: t.text?.trim() || t.lastTitle || '(untitled task)',
    fields: [
      F('board', board ?? t.homeTabId),
      F('status', t.status),
      F('assignee', assignee),
      F('reviewer', reviewer),
      F('due', t.date),
      F('priority', t.priority),
      F('created', iso(t.createdAt)),
      ...(t.deletedAt ? [F('deleted', iso(t.deletedAt))] : []),
    ],
  };
}

async function resolveTab(id: string): Promise<PreviewRecord | null> {
  const [t] = await db.select().from(schema.tabs).where(eq(schema.tabs.id, id)).limit(1);
  if (!t) return null;
  const [c] = await db.select({ n: sql<number>`count(*)` }).from(schema.boardMembers).where(eq(schema.boardMembers.tabId, id));
  const s = (t.settings ?? {}) as { requireReview?: boolean; restrictDelete?: string };
  return {
    type: 'tab', id, deleted: false, title: t.name,
    fields: [
      F('members', Number(c?.n ?? 0)),
      F('type', t.type),
      F('require review', s.requireReview ? 'yes' : 'no'),
      F('restrict delete', s.restrictDelete === 'admin' ? 'admins only' : 'no'),
      ...(t.location ? [F('location', t.location)] : []),
    ],
  };
}

async function resolveUser(id: string): Promise<PreviewRecord | null> {
  const [u] = await db
    .select({ email: schema.users.email, role: schema.users.role, createdAt: schema.users.createdAt, deactivatedAt: schema.users.deactivatedAt })
    .from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!u) return null;
  return {
    type: 'user', id, deleted: !!u.deactivatedAt, title: u.email,
    fields: [F('role', u.role), F('status', u.deactivatedAt ? 'deactivated' : 'active'), F('joined', iso(u.createdAt))],
  };
}

async function resolveMember(userId: string, scope: string | undefined): Promise<PreviewRecord | null> {
  if (!scope) return null;
  const [m] = await db
    .select({ role: schema.boardMembers.role })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.tabId, scope), eq(schema.boardMembers.userId, userId)))
    .limit(1);
  if (!m) return null; // membership gone (removed) → client shows a tombstone from the row payload
  const [email, board] = await Promise.all([emailOf(userId), boardNameOf(scope)]);
  return {
    type: 'board_member', id: userId, deleted: false,
    title: `${email ?? userId} · ${board ?? scope}`,
    fields: [F('board', board ?? scope), F('member', email ?? userId), F('role', m.role)],
  };
}

/** The record's own change list, straight from the audit log (target_id match). Newest first. */
async function recordHistory(id: string) {
  const rows = await db
    .select({
      id: schema.auditLog.id,
      actorId: schema.auditLog.actorId,
      actorEmail: schema.users.email,
      action: schema.auditLog.action,
      payload: schema.auditLog.payload,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
    .where(eq(schema.auditLog.targetId, id))
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(20);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);
  app.addHook('preHandler', requireSudo);

  // Read-only preview of a record behind an audit id (target / actor / scope). `scope` names the
  // board for a board_member. Returns null record when purged → the client tombstones from payload.
  app.get('/api/admin/record/:type/:id', async (req) => {
    const { type, id } = req.params as { type: string; id: string };
    const scope = (req.query as { scope?: string }).scope;
    let record: PreviewRecord | null = null;
    if (type === 'task') record = await resolveTask(id);
    else if (type === 'tab') record = await resolveTab(id);
    else if (type === 'user') record = await resolveUser(id);
    else if (type === 'board_member') record = await resolveMember(id, scope);
    const history = await recordHistory(id);
    return { record, history };
  });

  // Paginated browse. Newest first; `nextCursor` is null when exhausted.
  app.get('/api/admin/audit', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const conds = conditions(readFilters(q));
    if (q.cursor) conds.push(decodeCursor(q.cursor));

    const rows = await rowsQuery()
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
      .limit(limit);

    const entries = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return { entries, nextCursor };
  });

  // Filtered export, streamed in keyset batches to bound memory. CSV or NDJSON.
  app.get('/api/admin/audit/export', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const format = q.format === 'ndjson' ? 'ndjson' : 'csv';
    const base = conditions(readFilters(q));

    async function* stream(): AsyncGenerator<string> {
      if (format === 'csv') yield CSV_HEADER + '\n';
      let cursor: SQL | null = null;
      const BATCH = 1000;
      for (;;) {
        const conds = cursor ? [...base, cursor] : base;
        const rows = await rowsQuery()
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
          .limit(BATCH);
        if (!rows.length) break;
        for (const r of rows) yield format === 'csv' ? csvLine(r) : ndjsonLine(r);
        if (rows.length < BATCH) break;
        const last = rows[rows.length - 1];
        cursor = decodeCursor(encodeCursor(last.createdAt, last.id));
      }
    }

    reply.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="audit-${Date.now()}.${format}"`);
    return reply.send(Readable.from(stream()));
  });
}
