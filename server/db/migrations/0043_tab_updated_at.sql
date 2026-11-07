-- When a board last changed, for ordering the boards page. Existing boards start from their newest
-- task's update, so the order people see today survives the migration.

ALTER TABLE "tabs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
UPDATE "tabs" SET "updated_at" = COALESCE((SELECT max("updated_at") FROM "tasks" WHERE "tasks"."home_tab_id" = "tabs"."id"), "tabs"."updated_at");
