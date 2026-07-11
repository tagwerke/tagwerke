// Seed a batch of test users (dev/demo only) so surfaces like the add-member lookup have people
// to find. Idempotent: an email that already exists is left untouched.
//
//   tsx server/scripts/seed-users.ts                       # 5 admin users, password "password123"
//   tsx server/scripts/seed-users.ts 10                    # 10 of them
//   tsx server/scripts/seed-users.ts 5 --role member       # platform members, not admins
//   tsx server/scripts/seed-users.ts 5 --password hunter2  # set the shared password
//   tsx server/scripts/seed-users.ts 5 --domain acme.test  # seedN@acme.test
//   tsx server/scripts/seed-users.ts 5 --board <tabId> --board-role editor   # also add to a board
//
// Remove any of them later with:  npm run erase-user -- --email seed1@example.com

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';
import { hashPassword } from '../auth/password.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const count = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 5);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be 1..100');
  const role = (arg('role') ?? 'admin') as 'admin' | 'member';
  if (role !== 'admin' && role !== 'member') throw new Error('--role must be admin or member');
  const domain = arg('domain') ?? 'example.com';
  const password = arg('password') ?? 'password123';
  const board = arg('board'); // optional tab/board id to add each seeded user to
  const boardRole = (arg('board-role') ?? 'editor') as 'viewer' | 'editor' | 'admin';

  const passwordHash = await hashPassword(password);
  const created: string[] = [];
  const skipped: string[] = [];

  for (let n = 1; n <= count; n++) {
    const email = `seed${n}@${domain}`.toLowerCase();
    const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    let userId = existing[0]?.id;
    if (userId) {
      skipped.push(email);
    } else {
      userId = nanoid();
      await db.insert(schema.users).values({ id: userId, email, passwordHash, role });
      created.push(email);
    }

    if (board) {
      const onBoard = await db
        .select({ userId: schema.boardMembers.userId })
        .from(schema.boardMembers)
        .where(and(eq(schema.boardMembers.tabId, board), eq(schema.boardMembers.userId, userId)))
        .limit(1);
      if (!onBoard.length) {
        const posRows = await db
          .select({ next: sql<number>`coalesce(max(${schema.boardMembers.position}), -1) + 1` })
          .from(schema.boardMembers)
          .where(eq(schema.boardMembers.userId, userId));
        await db.insert(schema.boardMembers).values({
          tabId: board,
          userId,
          role: boardRole,
          position: Number(posRows[0]?.next ?? 0),
          starred: false,
        });
      }
    }
  }

  console.log(`\n  seeded ${created.length} user(s) as ${role}${board ? ` (added to board ${board} as ${boardRole})` : ''}`);
  if (created.length) console.log(`    ${created.join('\n    ')}`);
  if (skipped.length) console.log(`  skipped ${skipped.length} existing: ${skipped.join(', ')}`);
  console.log(`\n  shared password: ${password}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
