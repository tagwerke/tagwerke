ALTER TABLE "tasks" DROP CONSTRAINT "tasks_reviewer_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "reviewer_id";