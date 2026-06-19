// Set or clear a user's platform role.
//   tsx server/scripts/promote-admin.ts <email>            # -> admin
//   tsx server/scripts/promote-admin.ts <email> member     # -> member
import 'dotenv/config';
import pg from 'pg';

const email = process.argv[2];
const role = process.argv[3] ?? 'admin';
if (!email) throw new Error('usage: tsx server/scripts/promote-admin.ts <email> [admin|member]');
if (role !== 'admin' && role !== 'member') throw new Error('role must be admin or member');

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, keepAlive: true });
await c.connect();
const r = await c.query('UPDATE users SET role=$2 WHERE email=$1 RETURNING email, role', [email, role]);
console.log(r.rowCount ? `updated: ${r.rows[0].email} -> ${r.rows[0].role}` : `no user with email ${email}`);
await c.end();
