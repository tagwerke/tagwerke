// Mint a signup invite code.
//
//   npm run invite                      # single-use, never expires
//   npm run invite -- --uses 5          # reusable up to 5 signups
//   npm run invite -- --days 7          # expires in 7 days
//   npm run invite -- --note "for bob"  # attach a memo
//
// Prints the code to share. Signup requires it via the inviteCode field.

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { db, schema, pool } from '../db/client.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const maxUses = Number(arg('uses') ?? 1);
  if (!Number.isInteger(maxUses) || maxUses < 1) throw new Error('--uses must be a positive integer');
  const days = arg('days') ? Number(arg('days')) : null;
  if (days != null && (!Number.isFinite(days) || days <= 0)) throw new Error('--days must be a positive number');
  const note = arg('note') ?? null;

  const code = nanoid(12);
  const expiresAt = days != null ? new Date(Date.now() + days * 86400000) : null;

  await db.insert(schema.invites).values({ code, maxUses, expiresAt, note });

  console.log('\n  invite code:', code);
  console.log('  uses:', maxUses);
  console.log('  expires:', expiresAt ? expiresAt.toISOString() : 'never');
  if (note) console.log('  note:', note);
  console.log('');

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
