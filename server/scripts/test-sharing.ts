// Integration check of the v2 read path + permission model against the live DB.
// Non-destructive: any membership it creates is removed at the end.
//   npx tsx server/scripts/test-sharing.ts

import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';
import { assembleState } from '../lib/assembleState.ts';
import { boardRole } from '../auth/boards.ts';

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function userId(email: string): Promise<string> {
  const r = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!r.length) throw new Error(`no user ${email}`);
  return r[0].id;
}

async function main() {
  const owner = await userId('kirill@knyazev.ca');
  const other = await userId('bob@example.com');

  // A normal (non-today) board owned by kirill.
  const boards = await db.select().from(schema.tabs).where(eq(schema.tabs.createdBy, owner));
  const board = boards.find((b) => b.type !== 'today');
  if (!board) throw new Error('no normal board for owner');
  console.log(`\nusing board "${board.name}" (${board.id})\n`);

  // 1) Baseline isolation: bob is not a member; cannot see it.
  assert((await boardRole(other, board.id)) === null, 'bob has no role on the board initially');
  const before = await assembleState(other);
  assert(!(board.id in (before.tabs as Record<string, unknown>)), "board absent from bob's state initially");
  const beforeCount = Object.keys(before.tabs as Record<string, unknown>).length;

  // 2) Share it with bob as viewer.
  await db.insert(schema.boardMembers).values({ tabId: board.id, userId: other, role: 'viewer', position: 999, starred: false });
  try {
    assert((await boardRole(other, board.id)) === 'viewer', 'bob now has viewer role');
    const after = await assembleState(other);
    const tabsAfter = after.tabs as Record<string, unknown>;
    assert(board.id in tabsAfter, "shared board now appears in bob's state");
    assert(Object.keys(tabsAfter).length === beforeCount + 1, 'exactly one board was added');

    // Tasks of the shared board are now visible to bob.
    const boardTaskCount = (await db.select().from(schema.tasks).where(eq(schema.tasks.homeTabId, board.id))).length;
    const visibleTasks = Object.values(after.tasks as Record<string, { homeTabId: string }>).filter(
      (t) => t.homeTabId === board.id,
    ).length;
    assert(visibleTasks === boardTaskCount, `bob sees all ${boardTaskCount} task(s) of the shared board`);

    // Owner's own view is unaffected (still sees their board, still admin).
    assert((await boardRole(owner, board.id)) === 'admin', 'owner remains admin of the board');
  } finally {
    // 3) Cleanup — restore the world (scoped to exactly this board + user).
    await db
      .delete(schema.boardMembers)
      .where(and(eq(schema.boardMembers.tabId, board.id), eq(schema.boardMembers.userId, other)));
  }
  assert((await boardRole(other, board.id)) === null, 'membership cleaned up; bob has no role again');

  await pool.end();
  console.log(process.exitCode ? '\nFAILED\n' : '\nall checks passed\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
