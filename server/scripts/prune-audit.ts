// Retention prune for the audit log (GDPR storage limitation, Art. 5). Deletes audit_log
// rows older than the retention window. Wire to a scheduled run (cron / container job).
//
//   npm run prune-audit                 # delete rows older than 12 months (default)
//   npm run prune-audit -- --months 6   # custom window
//   npm run prune-audit -- --dry        # report how many WOULD be deleted, delete nothing
//
// See AUTH_IMPLEMENTATION_PLAN.md (Slice 3).

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const months = Number(arg('months') ?? 12);
  if (!Number.isFinite(months) || months <= 0) throw new Error('--months must be a positive number');
  const cutoff = sql`now() - make_interval(months => ${months})`;

  if (flag('dry')) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.createdAt} < ${cutoff}`);
    console.log(`\n  [dry run] ${n} audit row(s) older than ${months} month(s) would be deleted\n`);
    return;
  }

  const res = await db.delete(schema.auditLog).where(sql`${schema.auditLog.createdAt} < ${cutoff}`);
  console.log(`\n  pruned ${res.rowCount ?? 0} audit row(s) older than ${months} month(s)\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
