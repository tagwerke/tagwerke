-- SUBTASKS_PLAN P7 — retire `tasks.position`, superseded by the fractional `rank` (D4).
--
-- `position` was never a manual order. Kanban had no within-column reordering, so the column was
-- only ever a column-append counter and sat at 0 for almost every row. `rank` replaced it as the
-- ONE order every view reads.
--
-- Hand-edited after `drizzle-kit generate` to add the guard below. Dropping a column is
-- irreversible, and this particular drop is only safe AFTER the rank backfill has run: until then a
-- row with no rank has nothing to order it by, and the ordering of every board on the instance
-- would be silently lost. A migration that can be run in the wrong order eventually will be, so it
-- refuses instead of trusting anything upstream of it.
--
-- In practice nothing upstream is trusted to remember either: boot backfills before calling
-- migrate() (server/db/ensure-rank.ts), because 0026 adds the column and this file needs it filled,
-- and the two apply in ONE transaction — there is no window between them for an operator to run a
-- script in. The guard is the backstop for the paths that skip boot (a manual `drizzle-kit migrate`,
-- a restored dump migrated by hand).
--
-- (Soft-deleted rows are excluded: they are ranked by the backfill too, but a pre-existing trashed
-- row from before this work is harmless — it has no order to lose until it is restored, at which
-- point the restore path assigns one.)

DO $$
DECLARE unranked bigint;
BEGIN
  SELECT count(*) INTO unranked FROM tasks WHERE rank IS NULL AND deleted_at IS NULL;
  IF unranked > 0 THEN
    RAISE EXCEPTION
      'refusing to drop tasks.position: % live task(s) still have no rank. Run `npm run backfill:task-rank -- --apply` first.', unranked;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "tasks" DROP COLUMN "position";
