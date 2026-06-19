// One-off sanity check of the v2 backfill. Read-only. Run after migrating.
//   npx tsx server/scripts/verify-v2.ts

import 'dotenv/config';
import pg from 'pg';

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, keepAlive: true });
  await client.connect();
  const q = async (sql: string) => (await client.query(sql)).rows;

  const checks: [string, string][] = [
    ['tabs total', `SELECT count(*)::int n FROM tabs`],
    ['memberships total', `SELECT count(*)::int n FROM board_members`],
    ['membership roles', `SELECT role, count(*)::int n FROM board_members GROUP BY role ORDER BY role`],
    ['tabs WITHOUT any membership (should be 0)',
      `SELECT count(*)::int n FROM tabs t WHERE NOT EXISTS (SELECT 1 FROM board_members m WHERE m.tab_id = t.id)`],
    ['tabs WITHOUT an admin (should be 0)',
      `SELECT count(*)::int n FROM tabs t WHERE NOT EXISTS (SELECT 1 FROM board_members m WHERE m.tab_id = t.id AND m.role='admin')`],
    ['tabs.created_by NULL (should be 0)', `SELECT count(*)::int n FROM tabs WHERE created_by IS NULL`],
    ['tasks.created_by NULL (should be 0)', `SELECT count(*)::int n FROM tasks WHERE created_by IS NULL`],
    ['memberships whose category_id is missing a project (informational)',
      `SELECT count(*)::int n FROM board_members m WHERE m.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = m.category_id)`],
    ['memberships where view-state differs from legacy tab (should be 0 right after backfill)',
      `SELECT count(*)::int n FROM board_members m JOIN tabs t ON t.id = m.tab_id AND t.user_id = m.user_id
       WHERE m.starred IS DISTINCT FROM t.starred OR m.position IS DISTINCT FROM t.position
          OR m.category_id IS DISTINCT FROM t.project_id`],
    ['platform admins', `SELECT email, role FROM users WHERE role='admin' ORDER BY email`],
    ['users by role', `SELECT role, count(*)::int n FROM users GROUP BY role ORDER BY role`],
  ];

  for (const [label, sql] of checks) {
    const rows = await q(sql);
    console.log(`\n• ${label}`);
    console.table(rows);
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
