// SUBTASKS_PLAN P2 — operator front-end for the `tasks.rank` backfill.
//
// The backfill itself lives in server/db/rank-backfill.ts, because boot runs it too: an upgrading
// instance ranks itself before migration 0027 drops `position` (see server/db/ensure-rank.ts), so
// nobody has to remember to run this. What this adds is the part an unattended boot can't offer —
// a dry run that shows the order it is about to make permanent, and --force to re-rank rows that
// already carry a key.
//
// Usage:
//   tsx server/scripts/backfill-task-rank.ts            # dry run: report only, writes nothing
//   tsx server/scripts/backfill-task-rank.ts --apply    # write the ranks
//   tsx server/scripts/backfill-task-rank.ts --board <tabId> [--apply]
//   tsx server/scripts/backfill-task-rank.ts --force --apply   # re-rank even already-ranked rows
//
// Idempotent: rows that already have a valid rank are left alone unless --force is passed.

import 'dotenv/config';
import { planRankBackfill, writeRankUpdates } from '../db/rank-backfill.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const boardArg = argv.indexOf('--board');
  const onlyBoard = boardArg >= 0 ? argv[boardArg + 1] : null;

  const plans = await planRankBackfill({ boardId: onlyBoard, force });

  if (!plans.length) {
    console.error(onlyBoard ? `No board with id ${onlyBoard}, or it has no tasks.` : 'No boards with tasks found.');
    process.exit(1);
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${plans.length} board(s)\n`);

  for (const p of plans) {
    console.log(`  ${p.name || p.id}`);
    console.log(`      ${p.tasks} task(s), ${p.groups} parent group(s), ${p.docRefs} doc ref(s), ${p.withoutRef} without a ref`);
    console.log(`      ${p.ranked} to rank, ${p.skipped} already ranked`);
    for (const row of p.preview) {
      console.log(`      ${row.rank.padEnd(5)} ${row.child ? '└ ' : ''}${row.label}${row.trashed ? '  [trashed]' : ''}`);
    }
    console.log('');
  }

  const updates = plans.flatMap((p) => p.updates);
  const skipped = plans.reduce((n, p) => n + p.skipped, 0);
  console.log(`Total: ${updates.length} to rank, ${skipped} already ranked.`);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to commit.');
    process.exit(0);
  }

  await writeRankUpdates(updates, (done, total) => console.log(`  wrote ${done}/${total}`));

  // Post-condition: re-plan the same scope and expect nothing left to do. Scoped rather than
  // instance-wide so `--board` isn't reported as a failure because some other board is unranked.
  const after = await planRankBackfill({ boardId: onlyBoard });
  const left = after.reduce((n, p) => n + p.ranked, 0);
  if (left) {
    console.error(`\nFAIL: ${left} task(s) still without a valid rank.`);
    process.exit(1);
  }
  console.log(`\nDone. ${updates.length} task(s) ranked.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
