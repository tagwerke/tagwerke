// Logical backup of all user content to a timestamped JSON file. A platform-independent
// restore point to take before schema migrations.
//
//   npm run backup
//
// Robustness notes: uses ONE keep-alive connection and runs queries SERIALLY (not a
// parallel pool) — a parallel burst trips connection poolers (PgBouncer/Traefik TCP)
// and yields "Connection terminated unexpectedly". Reads via raw `SELECT *` so it works
// across schema versions and never depends on columns that may not exist yet. Missing
// tables are skipped, not fatal. Run it wherever the DB is reachable (the deploy host
// or a tunnel) if your laptop can't reach it.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const TABLES = [
  'users',
  'projects',
  'tabs',
  'tasks',
  'today_blocks',
  'today_block_tasks',
  'snapshots',
  'invites',
  'board_members',
  'events',
  'event_attendance',
] as const;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const client = new pg.Client({
    connectionString,
    keepAlive: true,
    // Hosted PGs that require TLS but use self-signed certs: allow opting in without
    // failing cert verification. No-op when the server doesn't use SSL.
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    try {
      const res = await client.query(`SELECT * FROM "${table}"`);
      data[table] = res.rows;
      counts[table] = res.rowCount ?? res.rows.length;
    } catch (e) {
      // Table may not exist yet (pre-migration) — record and continue.
      counts[table] = -1;
      console.warn(`  (skipped "${table}": ${(e as Error).message})`);
    }
  }

  await client.end();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dump = { takenAt: new Date().toISOString(), counts, data };
  mkdirSync('backups', { recursive: true });
  const file = `backups/backup-${stamp}.json`;
  writeFileSync(file, JSON.stringify(dump, null, 2));

  console.log('\n  backup written:', file);
  console.log('  counts:', JSON.stringify(counts));
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
