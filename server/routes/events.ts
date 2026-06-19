// Board calendar facet: events (optionally recurring via RRULE) + per-occurrence
// attendance. Reading requires viewer; creating/editing requires editor; setting your
// OWN attendance requires only membership (a viewer may RSVP).
//
// Recurrence is stored as an iCal RRULE and expanded on read within a window — no
// row-per-occurrence. Attendance is keyed (event, occurrence_date, user) so each
// instance of a recurring event has its own roster, mirroring iCal RECURRENCE-ID.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import rrule from 'rrule';
import { nanoid } from 'nanoid';

// rrule ships CJS (`main`); under Node ESM (tsx) the named export isn't visible, so
// default-import the module and destructure.
const { RRule } = rrule;
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole } from '../auth/boards.ts';

const tabIdParam = (req: { params: unknown }) => (req.params as { id: string }).id;

/** Resolve the board that owns the event named in the route param. */
async function eventBoard(req: FastifyRequest): Promise<string | undefined> {
  const { id } = req.params as { id: string };
  const rows = await db.select({ tabId: schema.events.tabId }).from(schema.events).where(eq(schema.events.id, id)).limit(1);
  return rows[0]?.tabId;
}

const eventBody = z.object({
  start: z.string().nullable().optional(),
  end: z.string().nullable().optional(),
  rrule: z.string().nullable().optional(),
});
const attendanceBody = z.object({
  occurrenceDate: z.string().min(8).max(10), // 'YYYY-MM-DD'
  status: z.enum(['accepted', 'declined', 'tentative', 'needs-action']),
});

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type EventRow = typeof schema.events.$inferSelect;

/** Occurrence dates of an event within [from, to]. One-offs always include their date. */
function expand(ev: EventRow, from: Date, to: Date): string[] {
  if (!ev.rrule) return ev.start ? [ev.start.slice(0, 10)] : [];
  try {
    const opts = RRule.parseString(ev.rrule);
    opts.dtstart = ev.start ? new Date(ev.start) : from;
    return new RRule(opts).between(from, to, true).map(ymd);
  } catch {
    return ev.start ? [ev.start.slice(0, 10)] : [];
  }
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // List a board's events expanded into occurrences, with attendance + the roster.
  app.get('/api/tabs/:id/events', { preHandler: requireBoardRole('viewer', tabIdParam) }, async (req) => {
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

    // attendance: eventId -> occurrenceDate -> [{userId, status}]
    const byEvent = new Map<string, Map<string, { userId: string; status: string }[]>>();
    for (const a of attRows) {
      const m = byEvent.get(a.eventId) ?? new Map();
      const list = m.get(a.occurrenceDate) ?? [];
      list.push({ userId: a.userId, status: a.status });
      m.set(a.occurrenceDate, list);
      byEvent.set(a.eventId, m);
    }

    const events = evs.map((e) => ({
      id: e.id,
      start: e.start,
      end: e.end,
      rrule: e.rrule,
      occurrences: expand(e, from, to).map((date) => ({
        date,
        attendance: byEvent.get(e.id)?.get(date) ?? [],
      })),
    }));
    return { events, roster };
  });

  // Create an event on the board.
  app.post('/api/tabs/:id/events', { preHandler: requireBoardRole('editor', tabIdParam) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = eventBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid event' });
    const eventId = nanoid();
    await db.insert(schema.events).values({
      id: eventId,
      tabId: id,
      start: b.data.start ?? null,
      end: b.data.end ?? null,
      rrule: b.data.rrule ?? null,
      uid: `${eventId}@do-app`, // portable iCal identity
    });
    return reply.code(201).send({ ok: true, id: eventId });
  });

  app.patch('/api/events/:id', { preHandler: requireBoardRole('editor', eventBoard) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = eventBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid event' });
    await db.update(schema.events).set(b.data).where(eq(schema.events.id, id));
    return reply.send({ ok: true });
  });

  app.delete('/api/events/:id', { preHandler: requireBoardRole('editor', eventBoard) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.events).where(eq(schema.events.id, id));
    return reply.send({ ok: true });
  });

  // Set YOUR OWN attendance for one occurrence. Any member (incl. viewer) may RSVP.
  app.put('/api/events/:id/attendance', { preHandler: requireBoardRole('viewer', eventBoard) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = attendanceBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid attendance' });
    const userId = req.user!.id;
    await db
      .insert(schema.eventAttendance)
      .values({ eventId: id, occurrenceDate: b.data.occurrenceDate, userId, status: b.data.status })
      .onConflictDoUpdate({
        target: [schema.eventAttendance.eventId, schema.eventAttendance.occurrenceDate, schema.eventAttendance.userId],
        set: { status: b.data.status },
      });
    return reply.send({ ok: true });
  });
}
