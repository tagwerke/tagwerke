// Retention prune (GDPR storage limitation, Art. 5). Deletes audit_log rows older than the
// retention window, hard-deletes trashed tasks past the trash window, and purges trashed
// DOCUMENTS — including their objects, which no FK cascade can reach (see lib/documentGc.ts).
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
import { inArray, sql } from 'drizzle-orm';
import { db, schema, pool } from '../db/client.ts';
import { purgeObjects } from '../lib/documentGc.ts';

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
    const [{ d }] = await db
      .select({ d: sql<number>`count(*)::int` })
      .from(schema.documents)
      .where(sql`${schema.documents.deletedAt} is not null and ${schema.documents.deletedAt} < ${trashCutoff}`);
    console.log(`\n  [dry run] ${n} audit row(s) > ${months} month(s) and ${t} trashed task(s) > ${trashDays} day(s) would be deleted\n`);
    console.log(`  ...plus ${d} trashed document(s) and their objects`);
    return;
  }

  const res = await db.delete(schema.auditLog).where(sql`${schema.auditLog.createdAt} < ${auditCutoff}`);
  console.log(`\n  pruned ${res.rowCount ?? 0} audit row(s) older than ${months} month(s)`);
  const trash = await db.delete(schema.tasks).where(sql`${schema.tasks.deletedAt} is not null and ${schema.tasks.deletedAt} < ${trashCutoff}`);
  console.log(`  purged ${trash.rowCount ?? 0} trashed task(s) older than ${trashDays} day(s)\n`);

  // Objects FIRST, rows second. A crash between them leaks an object, which is invisible and
  // cheap to sweep; the reverse leaves a row pointing at nothing, which is a 500 on download.
  const doomed = await db
    .select({ id: schema.documents.id, storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(sql`${schema.documents.deletedAt} is not null and ${schema.documents.deletedAt} < ${trashCutoff}`);
  if (doomed.length > 0) {
    const purged = await purgeObjects(doomed.map((d) => d.storageKey), console);
    // Only rows whose object is actually gone are deleted. One left behind keeps its row, so
    // the next run retries it instead of losing track of the file forever.
    const removable = doomed.filter((d) => !purged.failed.includes(d.storageKey)).map((d) => d.id);
    if (removable.length > 0) {
      await db.delete(schema.documents).where(inArray(schema.documents.id, removable));
    }
    console.log(`  purged ${removable.length} trashed document(s) older than ${trashDays} day(s)`);
    if (purged.failed.length > 0) {
      console.error(`  ${purged.failed.length} object(s) could not be deleted — rows kept for the next run`);
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
