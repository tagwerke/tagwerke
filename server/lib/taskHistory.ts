// Reading the audit trail BACKWARDS.
//
// audit_log is written forward — one append-only row per change, each carrying the field diffs
// that change made ({field, from, to}, see audit.ts). That shape is enough to answer two recovery
// questions the timeline could always have answered but never did:
//
//   1. lastKnownTitle(id)  — "what was this task called, the last time it had a name?"
//      Used by the Trash restore. A task that was emptied before it was deleted would otherwise
//      come back as a blank line, which reads as data loss even though nothing was lost.
//
//   2. stateAsOf(id, entry) — "what did this task look like at that moment?"
//      Used by the point-in-time restore. Reconstructed by REWINDING: start from the row as it is
//      now and, walking newest → oldest, replace each field with the `from` of every change made
//      after the chosen entry. What's left is the value that entry left behind.
//
// Both are best-effort by nature: the trail is bounded (the retention prune drops audit rows past
// 12 months) and coarse rows carry no payload. A field the trail never saw change simply keeps its
// current value — which is correct, since a field with no diffs after the target point never moved.

import { and, desc, eq, gt, or } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import type { FieldChange } from './audit.ts';

// How far back either question will read. The history UI shows the newest 100 entries, so the
// entry a user can actually click always has fewer than 100 rows newer than it — this bound is
// slack, not a limit anyone reaches. It exists so a task with a pathological trail can't turn one
// click into an unbounded read.
const TRAIL_LIMIT = 500;

interface TrailRow {
  id: string;
  payload: unknown;
  createdAt: Date;
}

/** The `changes` array of an enriched edit payload, or [] for coarse/snapshot rows. */
function changesOf(payload: unknown): FieldChange[] {
  if (!payload || typeof payload !== 'object') return [];
  const changes = (payload as { changes?: unknown }).changes;
  return Array.isArray(changes) ? (changes as FieldChange[]) : [];
}

/** A non-empty trimmed string, or null — the only shape either answer accepts for a title. */
function title(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * The newest non-empty title this task ever had, according to the trail. Null when the trail
 * never recorded one (never titled, or the rows aged out).
 *
 * Every place a title can appear is checked, newest row first: an edit's `to` (the newest value
 * that row knows), then its `from` (the value the row replaced — this is the one that answers
 * "someone cleared the title", where `to` is empty and `from` is what we want), then the DELETE
 * row's snapshot, then the create marker.
 */
export async function lastKnownTitle(taskId: string): Promise<string | null> {
  const rows = await trail(taskId);
  for (const row of rows) {
    for (const c of changesOf(row.payload)) {
      if (c.field !== 'text') continue;
      const known = title(c.to) ?? title(c.from);
      if (known) return known;
    }
    const p = row.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    const snapshot = title((p.snapshot as Record<string, unknown> | undefined)?.text);
    if (snapshot) return snapshot;
    const created = title((p.created as Record<string, unknown> | undefined)?.text);
    if (created) return created;
  }
  return null;
}

/** Newest-first audit rows for one task, bounded. */
async function trail(taskId: string): Promise<TrailRow[]> {
  return db
    .select({ id: schema.auditLog.id, payload: schema.auditLog.payload, createdAt: schema.auditLog.createdAt })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetType, 'task'), eq(schema.auditLog.targetId, taskId)))
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(TRAIL_LIMIT);
}

export interface PointInTime {
  /** When the target entry was written — the moment being restored to. */
  at: string;
  /** `fields`, valued as they were immediately AFTER the target entry. Raw: the caller validates. */
  values: Record<string, unknown>;
}

/**
 * The task's audited fields as of `entryId`, inclusive of that entry's own change — the state the
 * timeline row describes, matching the timestamp it shows. To undo a bad edit you pick the entry
 * BELOW it, which is the state that edit replaced.
 *
 * `current` is the live row; fields with no later diff keep its value. Returns null when the entry
 * isn't a history row for this task (wrong id, or pruned since the timeline was loaded).
 */
export async function stateAsOf(
  taskId: string,
  entryId: string,
  current: Record<string, unknown>,
  fields: readonly string[],
): Promise<PointInTime | null> {
  const target = (
    await db
      .select({ id: schema.auditLog.id, createdAt: schema.auditLog.createdAt })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.id, entryId),
          eq(schema.auditLog.targetType, 'task'),
          eq(schema.auditLog.targetId, taskId),
        ),
      )
      .limit(1)
  )[0];
  if (!target) return null;

  // Everything written after the target, in the same order the timeline lists it. The id
  // tiebreak isn't chronological (ids are random) but it IS the order the user saw, so
  // "everything above this row" means the same thing here as it did on screen.
  const newer = await db
    .select({ id: schema.auditLog.id, payload: schema.auditLog.payload, createdAt: schema.auditLog.createdAt })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetType, 'task'),
        eq(schema.auditLog.targetId, taskId),
        or(
          gt(schema.auditLog.createdAt, target.createdAt),
          and(eq(schema.auditLog.createdAt, target.createdAt), gt(schema.auditLog.id, target.id)),
        ),
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(TRAIL_LIMIT);

  const values: Record<string, unknown> = {};
  for (const f of fields) values[f] = current[f] ?? null;
  // Newest → oldest, so the last write to land on a field is the OLDEST `from` after the target:
  // exactly the value that stood once that entry was done.
  for (const row of newer) {
    for (const c of changesOf(row.payload)) {
      if (fields.includes(c.field)) values[c.field] = c.from ?? null;
    }
  }
  return { at: target.createdAt.toISOString(), values };
}
