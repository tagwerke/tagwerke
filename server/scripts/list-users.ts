// List all users with their platform role and board count.
//
//   npm run list-users
//
// The board count comes from `board_members`, not from a column on `tabs`. This script used to
// count `tabs WHERE t.user_id = u.id`, which stopped existing in migration 0003 when ownership
// moved to the membership row — so it had been failing with `column t.user_id does not exist` for
// a long time before anyone reached for it. Role is shown because it is usually the reason you are
// running this at all (see promote-admin.ts).

import { connect } from './_db.ts';

const c = await connect();

// Say WHICH database answered. These scripts take their connection string from the environment, so
// one aimed at prod and one aimed at localhost look identical on screen — and "no such user" from
// the wrong database is indistinguishable from a real answer.
const where = await c.query('SELECT current_database() AS db, inet_server_addr() AS host, inet_server_port() AS port');
const { db, host, port } = where.rows[0];
console.log(`\n  ${db} @ ${host ?? 'local socket'}:${port}\n`);

const r = await c.query(`
  SELECT u.email,
         u.role,
         u.created_at,
         (SELECT count(*)::int FROM board_members m WHERE m.user_id = u.id) AS boards
  FROM users u
  ORDER BY u.created_at ASC
`);

for (const row of r.rows) {
  const date = row.created_at.toISOString().slice(0, 10);
  console.log(`  ${date}  ${String(row.role).padEnd(6)}  boards=${String(row.boards).padStart(2)}  ${row.email}`);
}
console.log(`\n  ${r.rowCount} user(s)\n`);

await c.end();
