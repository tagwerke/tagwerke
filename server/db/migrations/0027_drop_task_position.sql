-- SUBTASKS_PLAN P7 — retire `tasks.position`, superseded by the fractional `rank` (D4).
--
-- `position` was never a manual order. Kanban had no within-column reordering, so the column was
-- only ever a column-append counter and sat at 0 for almost every row. `rank` replaced it as the
-- ONE order every view reads.
--
-- Hand-edited after `drizzle-kit generate` to add the guard below. Dropping a column is
-- irreversible, and this particular drop is only safe AFTER backfill-task-rank.ts has run: until
-- then a row with no rank has nothing to order it by, and the ordering of every board on the
-- instance would be silently lost. A migration that can be run in the wrong order eventually will
-- be, so it refuses instead of trusting the operator to remember.
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
