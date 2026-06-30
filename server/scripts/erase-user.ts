// Right-to-erasure (GDPR Art. 17). Deletes a user and their personal data, WITHOUT
// breaking two invariants:
//   - a board must never be left admin-less (mirrors the last-admin guard in members.ts):
//     for each board where the user is the sole admin, promote another member, or delete
//     the board if they were its only member;
//   - the audit log must SURVIVE (Art. 32): the user's actor id is pseudonymized to a
//     tombstone (not cascade-deleted), and their email is scrubbed from any audit payloads.
//
// Deleting the user cascades sessions / projects / board_members / time_blocks (owned) /
// event_attendance / board_activity, and sets-null tasks.assigneeId + others' time_blocks.
//
//   npm run erase-user -- --email a@b.com           # PREVIEW only (no changes)
//   npm run erase-user -- --email a@b.com --confirm  # actually erase
//
// See AUTH_IMPLEMENTATION_PLAN.md (Slice 3).

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// The transaction handle's type, derived so the helper accepts `tx` exactly.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function adminCount(tx: Tx, tabId: string): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.tabId, tabId), eq(schema.boardMembers.role, 'admin')));
  return n;
}

async function main() {
  const email = arg('email');
  if (!email) throw new Error('usage: npm run erase-user -- --email <email> [--confirm]');

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
  if (!user) throw new Error(`No user with email ${email}`);
  const uid = user.id;

  // Boards where the user is an admin — the ones that might be left admin-less.
  const adminBoards = await db
    .select({ tabId: schema.boardMembers.tabId })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.userId, uid), eq(schema.boardMembers.role, 'admin')));

  if (!flag('confirm')) {
    console.log(`\n  [preview] would erase ${user.email} (${uid})`);
    console.log(`    admin on ${adminBoards.length} board(s); sole-admin boards will be promoted or deleted`);
    console.log('    cascades: sessions, projects, board_members, time_blocks, event_attendance, board_activity');
    console.log('    audit: actor pseudonymized to a tombstone; email scrubbed from payloads');
    console.log('\n  re-run with --confirm to apply\n');
    return;
  }

  await db.transaction(async (tx) => {
    // 1. Keep every board admin-ed. For boards where the user is the SOLE admin, promote the
    //    next member (lowest position = earliest filed) to admin; if they were the only
    //    member, delete the board (cascades its content).
    for (const { tabId } of adminBoards) {
      if ((await adminCount(tx, tabId)) > 1) continue; // another admin remains
      const [other] = await tx
        .select({ userId: schema.boardMembers.userId })
        .from(schema.boardMembers)
        .where(and(eq(schema.boardMembers.tabId, tabId), ne(schema.boardMembers.userId, uid)))
        .orderBy(asc(schema.boardMembers.position))
        .limit(1);
      if (other) {
        await tx
          .update(schema.boardMembers)
          .set({ role: 'admin' })
          .where(and(eq(schema.boardMembers.tabId, tabId), eq(schema.boardMembers.userId, other.userId)));
      } else {
        await tx.delete(schema.tabs).where(eq(schema.tabs.id, tabId)); // sole member's board
      }
    }

    // 2. Delete the user — FK cascade / set-null handle the rest of the app data.
    await tx.delete(schema.users).where(eq(schema.users.id, uid));

    // 3. Audit survives, pseudonymized: relabel the actor, and scrub the email out of any
    //    payloads (the subject's own signup/login rows AND others' member-add rows).
    const tombstone = `erased_${nanoid(8)}`;
    await tx.update(schema.auditLog).set({ actorId: tombstone }).where(eq(schema.auditLog.actorId, uid));
    await tx.execute(sql`
      UPDATE "audit_log"
      SET "payload" = jsonb_set("payload", '{email}', '"[erased]"')
      WHERE "payload" ? 'email' AND lower("payload"->>'email') = ${user.email.toLowerCase()}
    `);
  });

  console.log(`\n  erased ${user.email} (${uid}); audit trail preserved (pseudonymized)\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
