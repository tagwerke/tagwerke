ALTER TABLE "tabs" DROP CONSTRAINT "tabs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tabs" DROP CONSTRAINT "tabs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "tabs_user_idx";--> statement-breakpoint
DROP INDEX "tabs_project_idx";--> statement-breakpoint
DROP INDEX "tasks_user_idx";--> statement-breakpoint
ALTER TABLE "tabs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "tabs" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "tabs" DROP COLUMN "position";--> statement-breakpoint
ALTER TABLE "tabs" DROP COLUMN "starred";--> statement-breakpoint
ALTER TABLE "tabs" DROP COLUMN "starred_position";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "user_id";