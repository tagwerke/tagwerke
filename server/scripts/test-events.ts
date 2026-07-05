// Integration check of events (RRULE expansion) + attendance against the live DB.
// Non-destructive: removes the event it creates (attendance cascades).
//   npx tsx server/scripts/test-events.ts

import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import rrule from 'rrule';
import { db, schema, pool } from '../db/client.ts';

const { RRule } = rrule;

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const owner = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'kirill@knyazev.ca')).limit(1))[0].id;
  const board = (await db.select().from(schema.tabs).where(eq(schema.tabs.createdBy, owner))).find((b) => b.type !== 'today')!;

  // Weekly event starting "today".
  const start = new Date(new Date().toISOString().slice(0, 10) + 'T18:00:00.000Z');
  const eventId = nanoid();
  await db.insert(schema.events).values({ id: eventId, tabId: board.id, start: start.toISOString(), rrule: 'FREQ=WEEKLY', uid: `${eventId}@tagwerke` });

  try {
    // Expand the next 60 days — weekly should yield ~8-9 occurrences.
    const opts = RRule.parseString('FREQ=WEEKLY');
    opts.dtstart = start;
    const from = start;
    const to = new Date(from.getTime() + 60 * 86400000);
    const occ = new RRule(opts).between(from, to, true).map(ymd);
    assert(occ.length >= 8 && occ.length <= 10, `weekly expands to ~9 occurrences in 60 days (got ${occ.length})`);
    assert(occ[0] === ymd(start), 'first occurrence is the start date');

    // RSVP the owner "accepted" to the first occurrence (upsert).
    await db
      .insert(schema.eventAttendance)
      .values({ eventId, occurrenceDate: occ[0], userId: owner, status: 'accepted' })
      .onConflictDoUpdate({
        target: [schema.eventAttendance.eventId, schema.eventAttendance.occurrenceDate, schema.eventAttendance.userId],
        set: { status: 'accepted' },
      });
    // Change mind → tentative (tests the upsert path).
    await db
      .insert(schema.eventAttendance)
      .values({ eventId, occurrenceDate: occ[0], userId: owner, status: 'tentative' })
      .onConflictDoUpdate({
        target: [schema.eventAttendance.eventId, schema.eventAttendance.occurrenceDate, schema.eventAttendance.userId],
        set: { status: 'tentative' },
      });
    const att = await db
      .select()
      .from(schema.eventAttendance)
      .where(and(eq(schema.eventAttendance.eventId, eventId), eq(schema.eventAttendance.occurrenceDate, occ[0])));
    assert(att.length === 1 && att[0].status === 'tentative', 'attendance upsert keeps one row, latest status wins');
  } finally {
    await db.delete(schema.events).where(eq(schema.events.id, eventId)); // cascades attendance
  }

  const gone = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  assert(gone.length === 0, 'event cleaned up (attendance cascaded)');

  await pool.end();
  console.log(process.exitCode ? '\nFAILED\n' : '\nall checks passed\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
