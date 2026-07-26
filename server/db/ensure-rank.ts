// SUBTASKS_PLAN P7 — rank every task at boot, before migration 0027 drops `position`.
//
// 0027 refuses to drop the old column while any live task lacks a `rank`, because dropping it then
// would leave those rows with nothing to order them by. Correct — but a self-hosted instance
// upgrades by pulling a new image and restarting, and migrations run on boot (server/index.ts). The
// operator has no window in which to run the backfill script: 0026 (which adds `rank`) and 0027
// (which needs it filled) are applied in the SAME transaction, and if the guard fires the container
// exits, so there is no running container to exec into either. "Run the script first" is not an
// instruction an unattended upgrade can follow.
//
// So the boot sequence does it, in the only slot that exists: before migrate(). That means adding
// the `rank` column here rather than waiting for 0026 — which is why 0026 declares it
// IF NOT EXISTS. Everything else 0026 does (indexes, the composite FK) is left to the migration.
//
// Self-retiring: once 0027 has dropped `position`, the first check short-circuits, and the cost of
// this on every subsequent boot is two catalog lookups.

import { pool } from './client.ts';
import {
  columnExists,
  planRankBackfill,
  tableExists,
  unrankedLiveTaskCount,
  writeRankUpdates,
} from './rank-backfill.ts';

interface BootLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export async function ensureTaskRanks(log: BootLog): Promise<void> {
  // Fresh database: migrate() creates `tasks` with `rank` and no rows to backfill.
  if (!(await tableExists('tasks'))) return;
  // `position` gone means 0027 has already run, and every write path has minted ranks since.
  if (!(await columnExists('tasks', 'position'))) return;

  await pool.query('alter table tasks add column if not exists rank text collate "C"');

  const pending = await unrankedLiveTaskCount();
  if (!pending) return;

  log.warn(`task rank backfill: ${pending} task(s) without a rank — ranking from document order before migrating`);
  const plans = await planRankBackfill();
  const updates = plans.flatMap((p) => p.updates);
  await writeRankUpdates(updates);

  // Post-condition: 0027's guard is about to ask the same question, and a clear failure here beats
  // the same failure surfacing as an opaque migration error.
  const remaining = await unrankedLiveTaskCount();
  if (remaining) {
    throw new Error(
      `task rank backfill: ${remaining} live task(s) still have no rank after ranking ${updates.length}. ` +
        'Migration 0027 (drop tasks.position) cannot run safely; investigate before retrying.',
    );
  }

  log.info(`task rank backfill: ranked ${updates.length} task(s) across ${plans.length} board(s)`);
}
