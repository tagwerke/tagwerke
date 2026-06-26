ALTER TABLE "tasks" ADD COLUMN "status" text DEFAULT 'todo' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
-- P0 backfill: derive status from the legacy `done` flag.
UPDATE "tasks" SET "status" = CASE WHEN "done" THEN 'done' ELSE 'todo' END;--> statement-breakpoint
-- P0: auto-bump updated_at on every UPDATE (covers raw upserts / onConflictDoUpdate too),
-- so app code never has to remember to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_set_updated_at ON "tasks";--> statement-breakpoint
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();