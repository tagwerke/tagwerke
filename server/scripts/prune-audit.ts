// Retention prune (GDPR storage limitation, Art. 5). Deletes audit_log rows older than the
// retention window AND hard-deletes trashed tasks (soft-deleted) past the trash window. Wire
// to a scheduled run (cron / container job).
//
//   npm run prune-audit                     # audit > 12 months, trash > 30 days (defaults)
//   npm run prune-audit -- --months 6       # custom audit window
//   npm run prune-audit -- --trash-days 14  # custom trash window
//   npm run prune-audit -- --dry            # report counts, delete nothing
//
// See AUTH_IMPLEMENTATION_PLAN.md (Slice 3) and AUDIT_IMPLEMENTATION_PLAN.md (§G).

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
  const trashDays = Number(arg('trash-days') ?? 30);
  if (!Number.isFinite(trashDays) || trashDays <= 0) throw new Error('--trash-days must be a positive number');
  const auditCutoff = sql`now() - make_interval(months => ${months})`;
  const trashCutoff = sql`now() - make_interval(days => ${trashDays})`;

  if (flag('dry')) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.createdAt} < ${auditCutoff}`);
    const [{ t }] = await db
      .select({ t: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(sql`${schema.tasks.deletedAt} is not null and ${schema.tasks.deletedAt} < ${trashCutoff}`);
    console.log(`\n  [dry run] ${n} audit row(s) > ${months} month(s) and ${t} trashed task(s) > ${trashDays} day(s) would be deleted\n`);
    return;
  }

  const res = await db.delete(schema.auditLog).where(sql`${schema.auditLog.createdAt} < ${auditCutoff}`);
  console.log(`\n  pruned ${res.rowCount ?? 0} audit row(s) older than ${months} month(s)`);
  const trash = await db.delete(schema.tasks).where(sql`${schema.tasks.deletedAt} is not null and ${schema.tasks.deletedAt} < ${trashCutoff}`);
  console.log(`  purged ${trash.rowCount ?? 0} trashed task(s) older than ${trashDays} day(s)\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
