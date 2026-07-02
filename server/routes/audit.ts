// Audit-log visibility: an admin read surface over the existing append-only audit_log.
// Browse/filter (keyset-paginated) + export (CSV for auditors, NDJSON for SIEM). Read-only;
// the log is never mutated here. See AUTH_IMPLEMENTATION_PLAN.md (audit visibility).

import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAdmin, requireSudo } from '../auth/guard.ts';

interface Filters {
  action?: string;
  actor?: string; // matches actorId exactly OR actor email substring
  from?: string;
  to?: string;
  category?: string; // 'security' hides the high-volume coarse "METHOD /route" rows
}

function readFilters(q: Record<string, string | undefined>): Filters {
  return { action: q.action, actor: q.actor, from: q.from, to: q.to, category: q.category };
}

function conditions(f: Filters): SQL[] {
  const c: SQL[] = [];
  if (f.action) c.push(eq(schema.auditLog.action, f.action));
  if (f.actor) c.push(or(ilike(schema.users.email, `%${f.actor}%`), eq(schema.auditLog.actorId, f.actor))!);
  if (f.from) c.push(gte(schema.auditLog.createdAt, new Date(f.from)));
  if (f.to) c.push(lte(schema.auditLog.createdAt, new Date(f.to)));
  // Coarse mutation rows are written as "<METHOD> <route>" (with a space); named/security
  // events are single snake_case tokens. Exclude the former for the "security" view.
  if (f.category === 'security') c.push(sql`${schema.auditLog.action} NOT LIKE '% %'`);
  return c;
}

// Base select joined to users so the actor's email resolves (null actor / erased tombstone → null).
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
      method: schema.auditLog.method,
      status: schema.auditLog.status,
      createdAt: schema.auditLog.createdAt,
      payload: schema.auditLog.payload,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId));
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
const CSV_HEADER = 'createdAt,actorEmail,actorId,action,targetType,targetId,scopeId,method,status,payload';
function csvLine(r: Row): string {
  return [r.createdAt.toISOString(), r.actorEmail, r.actorId, r.action, r.targetType, r.targetId, r.scopeId, r.method, r.status, r.payload != null ? JSON.stringify(r.payload) : '']
    .map(csvEsc)
    .join(',') + '\n';
}
function ndjsonLine(r: Row): string {
  return JSON.stringify({ ...r, createdAt: r.createdAt.toISOString() }) + '\n';
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);
  app.addHook('preHandler', requireSudo);

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
