-- Retire the legacy Today aggregation tab (replaced by the Planner). Removing the
-- type='today' tab rows cascades their memberships, any tasks/events, and time_blocks.
DELETE FROM "tabs" WHERE "type" = 'today';--> statement-breakpoint
DROP TABLE "snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "today_block_tasks" CASCADE;--> statement-breakpoint
DROP TABLE "today_blocks" CASCADE;