// Audit trail — one append-only log of who-did-what. Two paths:
//
//   1. recordAudit(...)        — explicit, FULL-detail rows for security/structural events
//                                (logins, role changes). Handlers set req.auditHandled so
//                                the generic hook below doesn't double-log them.
//   2. registerAuditHook(app)  — one onResponse hook covering every other write route.
//                                Routine CONTENT edits (the high-volume persist path) get a
//                                COARSE row (no body); other mutations get a redacted body.
//
// Fire-and-forget: a failed audit write must NEVER break or delay the underlying request.
// See AUTH_IMPLEMENTATION_PLAN.md (Slice 2).

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { touchEdited } from './boardActivity.ts';

declare module 'fastify' {
  interface FastifyRequest {
    // Set by handlers that record their own enriched audit row, so the generic
    // onResponse hook skips them (no duplicate entry).
    auditHandled?: boolean;
  }
}

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  scopeId?: string | null; // the board/tab the action happened on
  method?: string | null;
  payload?: unknown; // null for coarse rows
  status?: number | null;
}

/** Append one audit row. Never throws into the caller — best-effort by design. */
export function recordAudit(entry: AuditEntry): void {
  void db
    .insert(schema.auditLog)
    .values({
      id: nanoid(),
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      scopeId: entry.scopeId ?? null,
      method: entry.method ?? null,
      payload: entry.payload ?? null,
      status: entry.status ?? null,
    })
    .catch(() => {
      /* best-effort: a failed audit write must not affect the request */
    });
}

/** One before→after field change, the unit of an enriched content-edit payload. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Field-level diff over a fixed key set: the changed fields, each with before/after.
 * `before` is the row as it was; `after` is the validated patch (only its present keys
 * are compared). Nullish is normalized so undefined↔null isn't reported as a change.
 */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!(field in after)) continue; // field wasn't part of this write
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

/**
 * Record an enriched content-edit row (field diffs) and mark the request handled so the
 * generic hook skips it. No-op when nothing changed. Use from handlers that already read
 * the row (tasks/tabs/time-blocks). See AUDIT_IMPLEMENTATION_PLAN §B2.
 */
export function auditEdit(
  req: { user?: { id: string } | null; auditHandled?: boolean; method?: string },
  entry: { action: string; targetType: string; targetId: string; scopeId?: string | null; changes: FieldChange[]; status?: number },
): void {
  req.auditHandled = true;
  if (!entry.changes.length) return;
  recordAudit({
    actorId: req.user?.id ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    scopeId: entry.scopeId ?? null,
    method: req.method ?? null,
    payload: { changes: entry.changes },
    status: entry.status ?? 200,
  });
}

// High-frequency content routes → coarse rows (no payload). Everything else mutating →
// full redacted body. Tab CONTENT is coarse; tab MEMBER management (.../members) is not.
const CONTENT_PREFIXES = ['/api/tasks', '/api/events', '/api/time-blocks'];

export function isContentRoute(path: string): boolean {
  if (CONTENT_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (path.startsWith('/api/tabs') && !path.includes('/members')) return true;
  return false;
}

/** Coarse entity classification of a mutation route, for the audit `targetType`. */
export function targetTypeForPath(path: string): string | null {
  if (path.startsWith('/api/tasks')) return 'task';
  if (path.startsWith('/api/time-blocks')) return 'time_block';
  if (path.startsWith('/api/events')) return 'event';
  if (path.startsWith('/api/tabs')) {
    if (path.includes('/events')) return 'event';
    if (path.includes('/members')) return 'board_member';
    return 'tab';
  }
  return null;
}

// Secrets never reach the log. Applied to non-content bodies; auth routes are skipped
// entirely (they self-enrich), so this is a belt-and-suspenders denylist.
const SECRET_KEYS = new Set(['password', 'newPassword', 'inviteCode', 'code', 'totp', 'token', 'backupCodes']);

function redact(body: unknown): unknown {
  if (!body || typeof body !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? '[redacted]' : v;
  }
  return out;
}

/** Register the catch-all mutation logger. Must run after auth populates req.user. */
export function registerAuditHook(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api')) return;
    if (req.auditHandled) return; // recorded with full detail elsewhere
    if (path.startsWith('/api/auth')) return; // sensitive + enriched in auth routes

    const coarse = isContentRoute(path);
    recordAudit({
      actorId: req.user?.id ?? null,
      action: `${req.method} ${req.routeOptions?.url ?? path}`,
      targetType: targetTypeForPath(path),
      targetId: (req.params as { id?: string } | undefined)?.id ?? null,
      // The board this write targeted, resolved for free by requireBoardRole. Makes the
      // row legible ("task X on tab Y") without a second lookup.
      scopeId: req.boardScope ?? null,
      method: req.method,
      payload: coarse ? null : redact(req.body),
      status: reply.statusCode,
    });

    // Board presence: a successful write to a board bumps the actor's "edited" time.
    // boardScope was resolved for free by requireBoardRole; reads + non-board writes
    // have none. (Reached only past the auditHandled/auth guards, so the seen beacon
    // and enriched role-changes don't count as edits.)
    if (req.user?.id && req.boardScope && reply.statusCode < 400) {
      touchEdited(req.boardScope, req.user.id);
    }
  });
}
