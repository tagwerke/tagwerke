-- SUBTASKS_PLAN P2 — make the task tree real in the database.
--
-- Hand-edited after `drizzle-kit generate` for two reasons the generator cannot know about:
--   1. Statement ORDER. The generator emitted the composite FK before the UNIQUE constraint it
--      references, which Postgres rejects. The unique must exist first.
--   2. COLLATE "C" on `rank`. Ranks are fractional index keys compared lexicographically, and the
--      client sorts them with plain JS string comparison (UTF-16 code units). Under a locale
--      collation Postgres folds case, so 'a' and 'A' would compare differently on the two sides
--      and the DB's order would silently diverge from the UI's. "C" is byte order — the same
--      order the client uses. See shared/rank.ts.
-- Neither edit is modelled in the drizzle snapshot (it tracks neither statement order nor
-- collations), so this file will not drift on the next generate.

-- Sibling order within a parent. Nullable until backfill-task-rank.ts has run.
ALTER TABLE "tasks" ADD COLUMN "rank" text COLLATE "C";--> statement-breakpoint

-- "children of X, in order" — the read every tree render performs, and the subtree walks in
-- delete/restore. Previously a sequential scan.
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "tasks_tree_idx" ON "tasks" USING btree ("home_tab_id","parent_task_id","rank");--> statement-breakpoint

-- Target for the composite FK. Redundant as a constraint (id is already the PK) but Postgres
-- requires a unique on the referenced column pair. MUST precede the FK below.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_id_home_uniq" UNIQUE("id","home_tab_id");--> statement-breakpoint

-- A parent must live on the same board as its child. Under MATCH SIMPLE (the default) a composite
-- FK is skipped entirely when any of its columns is NULL, so a root task passes freely — exactly
-- the semantics wanted. ON DELETE NO ACTION (not RESTRICT) matters: it defers its check to the end
-- of the statement, which lets the existing single-column FK's ON DELETE SET NULL null the
-- children's parent_task_id first. RESTRICT would check immediately and abort the delete.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_same_board" FOREIGN KEY ("parent_task_id","home_tab_id") REFERENCES "public"."tasks"("id","home_tab_id") ON DELETE no action ON UPDATE no action;
