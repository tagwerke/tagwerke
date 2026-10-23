// Keyset pagination for every newest-first list: the admin audit log, per-object history, the
// notification feed, Trash. One cursor shape for all of them — an opaque base64 of "<iso>|<id>" for
// the last row of a page — so the client treats it as a token and never builds one.
//
// The list MUST be ordered (timestamp desc, id desc). The id breaks ties between rows written in the
// same millisecond (an agent creating 25 tasks in a burst does exactly that), which is what keeps a
// page boundary from skipping or repeating a row.

import { sql, type Column, type SQL } from 'drizzle-orm';

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64');
}

/**
 * The condition "older than the cursor's row". A cursor that doesn't decode yields an empty page
 * rather than restarting from the top, which would hand the client rows it already has.
 */
export function olderThan(cursor: string, at: Column, id: Column): SQL {
  const [ts, rowId] = Buffer.from(cursor, 'base64').toString('utf8').split('|');
  const when = new Date(ts ?? '');
  if (!rowId || Number.isNaN(when.getTime())) return sql`false`;
  return sql`(${at}, ${id}) < (${when}, ${rowId})`;
}

/**
 * The mirror of `olderThan`: "newer than the cursor's row", for a client catching up oldest-first
 * (an agent asking what arrived since it last looked). Same rule for a cursor that doesn't decode.
 */
export function newerThan(cursor: string, at: Column, id: Column): SQL {
  const [ts, rowId] = Buffer.from(cursor, 'base64').toString('utf8').split('|');
  const when = new Date(ts ?? '');
  if (!rowId || Number.isNaN(when.getTime())) return sql`false`;
  return sql`(${at}, ${id}) > (${when}, ${rowId})`;
}

/** A page size from a query param, clamped to [1, max]. */
export function pageLimit(raw: string | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), max);
}

/** The cursor for the page after `rows`, or null when this page was the last. */
export function nextCursor<R>(rows: R[], limit: number, key: (r: R) => { at: Date | null; id: string }): string | null {
  const last = rows[rows.length - 1];
  if (rows.length < limit || !last) return null;
  const { at, id } = key(last);
  return at ? encodeCursor(at, id) : null;
}
