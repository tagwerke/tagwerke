// List users, or reset a user's password.
//
//   npm run reset-pw                                  # list all users
//   npm run reset-pw -- --email a@b.com --password X  # set new password
//   npm run reset-pw -- --email a@b.com               # generate a random password
//
// Resetting also clears any brute-force lock (failed_attempts / locked_until).

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';
import { hashPassword } from '../auth/password.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');

  if (!email) {
    // Convenience listing so you can find an email to reset. For a richer view
    // (board counts, signup dates) run `tsx server/scripts/list-users.ts`.
    const rows = await db
      .select({ id: schema.users.id, email: schema.users.email, createdAt: schema.users.createdAt })
      .from(schema.users);
    console.log(`\n  ${rows.length} user(s):`);
    for (const r of rows) console.log(`    ${r.email}  (${r.id})`);
    console.log('\n  To reset: npm run reset-pw -- --email <email> [--password <new>]\n');
    return;
  }

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!user) throw new Error(`No user with email ${email}`);

  const password = arg('password') ?? nanoid(16);
  const generated = !arg('password');
  const passwordHash = await hashPassword(password);

  await db
    .update(schema.users)
    .set({ passwordHash, failedAttempts: 0, lockedUntil: null })
    .where(eq(schema.users.id, user.id));

  console.log(`\n  Password reset for ${user.email}`);
  if (generated) console.log(`  new password: ${password}`);
  console.log('  brute-force lock cleared\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
