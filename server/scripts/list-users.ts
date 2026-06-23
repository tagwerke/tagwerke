// List all users with their board (tab) counts.
import { connect } from './_db.ts';

const c = await connect();
const r = await c.query(
  'SELECT email, created_at, (SELECT count(*)::int FROM tabs t WHERE t.user_id = u.id) AS tabs FROM users u ORDER BY created_at ASC',
);
for (const row of r.rows) {
  console.log(`${row.created_at.toISOString().slice(0, 10)}  tabs=${String(row.tabs).padStart(2)}  ${row.email}`);
}
await c.end();
