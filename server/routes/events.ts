// Calendar facet: events (optionally recurring via RRULE) + per-occurrence attendance.
//
// Two shapes of event share the `events` table (see CALENDAR_UI_PLAN.md):
//   - board-scoped (tab_id set): a project meeting. Auth derives from board_members —
//     read requires viewer, write requires editor, RSVP requires membership.
//   - board-less  (tab_id null): a 1:1 / personal meeting. OWNER-ONLY via created_by;
//     only the creator may see, edit, delete, or RSVP. No shared-visibility path yet.
//
// Recurrence is stored as an iCal RRULE and expanded on read within a window — no
// row-per-occurrence. Attendance is keyed (event, occurrence_date, user) so each
// instance of a recurring event has its own roster, mirroring iCal RECURRENCE-ID.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import rrule from 'rrule';
import { nanoid } from 'nanoid';

// rrule ships CJS (`main`); under Node ESM (tsx) the named export isn't visible, so
// default-import the module and destructure.
const { RRule } = rrule;
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId, hasBoardRole, type BoardRole } from '../auth/boards.ts';

type EventRow = typeof schema.events.$inferSelect;

/** Flat event projection shared by every read (avoids join-nested rows). */
const EVENT_COLS = {
  id: schema.events.id,
  tabId: schema.events.tabId,
  title: schema.events.title,
  start: schema.events.start,
  end: schema.events.end,
  allDay: schema.events.allDay,
  filter: schema.events.filter,
  rrule: schema.events.rrule,
  createdBy: schema.events.createdBy,
} as const;

/** Resolve the board that owns the event named in the route param (legacy routes). */
async function eventBoard(req: FastifyRequest): Promise<string | undefined> {
  const { id } = req.params as { id: string };
  const rows = await db.select({ tabId: schema.events.tabId }).from(schema.events).where(eq(schema.events.id, id)).limit(1);
  return rows[0]?.tabId ?? undefined;
}

/**
 * Load the event named in `:id` and authorize the caller for `min`.
 *   - board-scoped (tab_id set): requires >= min on that board.
 *   - board-less  (tab_id null): owner-only — created_by must be the caller (any action).
 * On success returns the row; otherwise sends a 404 and returns null. 404 (not 403) keeps
 * a board/event you can't see non-probeable, matching auth/boards.ts.
 */
async function authEvent(req: FastifyRequest, reply: FastifyReply, min: BoardRole): Promise<EventRow | null> {
  const { id } = req.params as { id: string };
  const userId = req.user!.id;
  const ev = (await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1))[0];
  if (!ev) {
    reply.code(404).send({ error: 'not found' });
    return null;
  }
  if (ev.tabId == null) {
    if (ev.createdBy !== userId) {
      reply.code(404).send({ error: 'not found' });
      return null;
    }
    return ev;
  }
  if (!(await hasBoardRole(userId, ev.tabId, min))) {
    reply.code(404).send({ error: 'not found' });
    return null;
  }
  req.boardScope = ev.tabId; // for the audit hook / board-activity
  return ev;
}

// Body for legacy per-board create + the shared /api/events/:id patch. All optional so a
// patch may carry any subset; tabId here means (re)binding — null detaches to a 1:1.
const eventBody = z.object({
  title: z.string().nullable().optional(),
  tabId: z.string().nullable().optional(),
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  allDay: z.boolean().optional(),
  filter: z.any().optional(),
  rrule: z.string().nullable().optional(),
});

// Calendar create: client-generated id (idempotent outbox replay), tabId optional/nullable.
const calendarCreateBody = z.object({
  id: z.string().min(1),
  tabId: z.string().min(1).nullable().optional(),
  title: z.string().nullable().optional(),
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  allDay: z.boolean().optional(),
  filter: z.any().optional(),
  rrule: z.string().nullable().optional(),
});

const attendanceBody = z.object({
  occurrenceDate: z.string().min(8).max(10), // 'YYYY-MM-DD'
  status: z.enum(['accepted', 'declined', 'tentative', 'needs-action']),
});

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Occurrence dates of an event within [from, to] (inclusive). */
function expand(ev: { start: string | null; rrule: string | null }, from: Date, to: Date): string[] {
  if (!ev.rrule) {
    if (!ev.start) return [];
    const d = ev.start.slice(0, 10);
    return d >= ymd(from) && d <= ymd(to) ? [d] : []; // clamp one-offs to the window
  }
  try {
    const opts = RRule.parseString(ev.rrule);
    opts.dtstart = ev.start ? new Date(ev.start) : from;
    return new RRule(opts).between(from, to, true).map(ymd);
  } catch {
    return ev.start ? [ev.start.slice(0, 10)] : [];
  }
}

/** attendance rows -> eventId -> occurrenceDate -> [{userId, status}] */
function attendanceByEvent(rows: (typeof schema.eventAttendance.$inferSelect)[]) {
  const byEvent = new Map<string, Map<string, { userId: string; status: string }[]>>();
  for (const a of rows) {
    const m = byEvent.get(a.eventId) ?? new Map();
    const list = m.get(a.occurrenceDate) ?? [];
    list.push({ userId: a.userId, status: a.status });
    m.set(a.occurrenceDate, list);
    byEvent.set(a.eventId, m);
  }
  return byEvent;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── Calendar (cross-board) ────────────────────────────────────────────────
  // The calendar's window read: every event on a board the caller is a member of,
  // PLUS the caller's own board-less (1:1) events, expanded into [from, to].
  app.get('/api/calendar/events', async (req) => {
    const userId = req.user!.id;
    const q = req.query as { from?: string; to?: string };
    const from = q.from ? new Date(q.from) : new Date(new Date().toISOString().slice(0, 10));
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 60 * 86400000);

    const boardEvs = await db
      .select(EVENT_COLS)
      .from(schema.events)
      .innerJoin(
        schema.boardMembers,
        and(eq(schema.boardMembers.tabId, schema.events.tabId), eq(schema.boardMembers.userId, userId)),
      );
    const personalEvs = await db
      .select(EVENT_COLS)
      .from(schema.events)
      .where(and(isNull(schema.events.tabId), eq(schema.events.createdBy, userId)));
    const evs = [...boardEvs, ...personalEvs];

    const evIds = evs.map((e) => e.id);
    const attRows = evIds.length
      ? await db.select().from(schema.eventAttendance).where(inArray(schema.eventAttendance.eventId, evIds))
      : [];
    const byEvent = attendanceByEvent(attRows);

    // Expand to occurrences and drop events with none inside [from, to].
    const events = evs
      .map((e) => ({
        ...e,
        occurrences: expand(e, from, to).map((date) => ({ date, attendance: byEvent.get(e.id)?.get(date) ?? [] })),
      }))
      .filter((e) => e.occurrences.length > 0);

    // roster covers everyone the UI must name in the RETURNED events: attendees + creators.
    const userIds = [
      ...new Set([
        ...events.flatMap((e) => e.occurrences.flatMap((o) => o.attendance.map((a) => a.userId))),
        ...events.map((e) => e.createdBy).filter((x): x is string => !!x),
      ]),
    ];
    const roster = userIds.length
      ? await db.select({ userId: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds))
      : [];
    return { events, roster };
  });

  // Create an event (board-scoped when tabId set, else board-less/owner-only). Accepts a
  // client id so the offline outbox can replay idempotently.
  app.post('/api/calendar/events', async (req, reply) => {
    const b = calendarCreateBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid event' });
    const userId = req.user!.id;
    const tabId = b.data.tabId ?? null;
    if (tabId !== null && !(await hasBoardRole(userId, tabId, 'editor')))
      return reply.code(404).send({ error: 'not found' });
    await db
      .insert(schema.events)
      .values({
        id: b.data.id,
        tabId,
        title: b.data.title ?? null,
        start: b.data.start ?? null,
        end: b.data.end ?? null,
        allDay: b.data.allDay ?? false,
        filter: b.data.filter ?? null,
        rrule: b.data.rrule ?? null,
        uid: `${b.data.id}@tagwerke`, // portable iCal identity
        createdBy: userId,
      })
      .onConflictDoNothing(); // idempotent replay
    return reply.code(201).send({ ok: true, id: b.data.id });
  });

  // ── Shared mutations (board-scoped OR board-less, via authEvent) ───────────
  app.patch('/api/events/:id', async (req, reply) => {
    const ev = await authEvent(req, reply, 'editor');
    if (!ev) return;
    const b = eventBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid event' });
    // Rebinding to a board requires editor there; null detaches to a 1:1 (owner already ok).
    if (b.data.tabId != null && !(await hasBoardRole(req.user!.id, b.data.tabId, 'editor')))
      return reply.code(404).send({ error: 'not found' });
    if (Object.keys(b.data).length === 0) return reply.send({ ok: true });
    await db.update(schema.events).set(b.data).where(eq(schema.events.id, ev.id));
    return reply.send({ ok: true });
  });

  app.delete('/api/events/:id', async (req, reply) => {
    const ev = await authEvent(req, reply, 'editor');
    if (!ev) return;
    await db.delete(schema.events).where(eq(schema.events.id, ev.id));
    return reply.send({ ok: true });
  });

  // Set YOUR OWN attendance for one occurrence. Any board member (incl. viewer) or the
  // owner of a board-less event may RSVP.
  app.put('/api/events/:id/attendance', async (req, reply) => {
    const ev = await authEvent(req, reply, 'viewer');
    if (!ev) return;
    const b = attendanceBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid attendance' });
    const userId = req.user!.id;
    await db
      .insert(schema.eventAttendance)
      .values({ eventId: ev.id, occurrenceDate: b.data.occurrenceDate, userId, status: b.data.status })
      .onConflictDoUpdate({
        target: [schema.eventAttendance.eventId, schema.eventAttendance.occurrenceDate, schema.eventAttendance.userId],
        set: { status: b.data.status },
      });
    return reply.send({ ok: true });
  });

  // ── Legacy per-board routes (still consumed by EventsPanel / BoardCalendar) ──
  app.get('/api/tabs/:id/events', { preHandler: requireBoardRole('viewer', paramTabId) }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { from?: string; to?: string };
    const from = q.from ? new Date(q.from) : new Date(new Date().toISOString().slice(0, 10));
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 60 * 86400000);

    const evs = await db.select().from(schema.events).where(eq(schema.events.tabId, id));
    const evIds = evs.map((e) => e.id);
    const attRows = evIds.length
      ? await db.select().from(schema.eventAttendance).where(inArray(schema.eventAttendance.eventId, evIds))
      : [];
    const roster = await db
      .select({ userId: schema.boardMembers.userId, email: schema.users.email })
      .from(schema.boardMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.boardMembers.userId))
      .where(eq(schema.boardMembers.tabId, id));
    const byEvent = attendanceByEvent(attRows);

    const events = evs.map((e) => ({
      id: e.id,
      start: e.start,
      end: e.end,
      rrule: e.rrule,
      occurrences: expand(e, from, to).map((date) => ({ date, attendance: byEvent.get(e.id)?.get(date) ?? [] })),
    }));
    return { events, roster };
  });

  app.post('/api/tabs/:id/events', { preHandler: requireBoardRole('editor', paramTabId) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = eventBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid event' });
    const eventId = nanoid();
    await db.insert(schema.events).values({
      id: eventId,
      tabId: id,
      title: b.data.title ?? null,
      start: b.data.start ?? null,
      end: b.data.end ?? null,
      allDay: b.data.allDay ?? false,
      filter: b.data.filter ?? null,
      rrule: b.data.rrule ?? null,
      uid: `${eventId}@tagwerke`,
      createdBy: req.user!.id,
    });
    return reply.code(201).send({ ok: true, id: eventId });
  });
}
