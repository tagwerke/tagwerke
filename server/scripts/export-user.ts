// Per-user data export (GDPR access & portability, Art. 15/20). Dumps ONE user's personal
// data + the content they authored — NOT whole shared boards (those contain other members'
// data). Output is a timestamped JSON file under exports/.
//
//   npm run export-user -- --email a@b.com
//
// See AUTH_IMPLEMENTATION_PLAN.md (Slice 3).

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  if (!email) throw new Error('usage: npm run export-user -- --email <email>');

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
  if (!user) throw new Error(`No user with email ${email}`);
  const uid = user.id;

  // Their personal categories.
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.userId, uid));

  // Their board memberships + the board NAME for context only (not the board's contents
  // or other members' tasks — that would be other people's data).
  const memberships = await db
    .select({
      tabId: schema.boardMembers.tabId,
      tabName: schema.tabs.name,
      role: schema.boardMembers.role,
      categoryId: schema.boardMembers.categoryId,
      starred: schema.boardMembers.starred,
    })
    .from(schema.boardMembers)
    .innerJoin(schema.tabs, eq(schema.tabs.id, schema.boardMembers.tabId))
    .where(eq(schema.boardMembers.userId, uid));

  // Content they authored or are assigned (their contribution across shared boards).
  const tasksAuthored = await db.select().from(schema.tasks).where(eq(schema.tasks.createdBy, uid));
  const tasksAssigned = await db.select().from(schema.tasks).where(eq(schema.tasks.assigneeId, uid));

  const timeBlocks = await db.select().from(schema.timeBlocks).where(eq(schema.timeBlocks.userId, uid));
  const eventAttendance = await db
    .select()
    .from(schema.eventAttendance)
    .where(eq(schema.eventAttendance.userId, uid));

  const bundle = {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt }, // no passwordHash
    projects,
    memberships,
    tasksAuthored,
    tasksAssigned,
    timeBlocks,
    eventAttendance,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync('exports', { recursive: true });
  const file = `exports/export-${uid}-${stamp}.json`;
  writeFileSync(file, JSON.stringify(bundle, null, 2));

  console.log(`\n  export written: ${file}`);
  console.log(
    `  projects:${projects.length} memberships:${memberships.length} ` +
      `tasksAuthored:${tasksAuthored.length} tasksAssigned:${tasksAssigned.length} ` +
      `timeBlocks:${timeBlocks.length} eventAttendance:${eventAttendance.length}\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
