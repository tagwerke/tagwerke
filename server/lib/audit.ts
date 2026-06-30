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
      method: entry.method ?? null,
      payload: entry.payload ?? null,
      status: entry.status ?? null,
    })
    .catch(() => {
      /* best-effort: a failed audit write must not affect the request */
    });
}

// High-frequency content routes → coarse rows (no payload). Everything else mutating →
// full redacted body. Tab CONTENT is coarse; tab MEMBER management (.../members) is not.
const CONTENT_PREFIXES = ['/api/tasks', '/api/events', '/api/time-blocks'];

function isContentRoute(path: string): boolean {
  if (CONTENT_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (path.startsWith('/api/tabs') && !path.includes('/members')) return true;
  return false;
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
      targetId: (req.params as { id?: string } | undefined)?.id ?? null,
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
