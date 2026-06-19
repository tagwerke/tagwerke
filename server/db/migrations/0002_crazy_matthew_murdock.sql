CREATE TABLE "board_members" (
	"tab_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"category_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"starred_position" integer,
	CONSTRAINT "board_members_tab_id_user_id_pk" PRIMARY KEY("tab_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "event_attendance" (
	"event_id" text NOT NULL,
	"occurrence_date" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'needs-action' NOT NULL,
	CONSTRAINT "event_attendance_event_id_occurrence_date_user_id_pk" PRIMARY KEY("event_id","occurrence_date","user_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"tab_id" text NOT NULL,
	"start" text,
	"end" text,
	"rrule" text,
	"uid" text,
	"external_event_id" text,
	"external_cal_id" text,
	"sync_token" text
);
--> statement-breakpoint
ALTER TABLE "tabs" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "tabs" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_members_user_idx" ON "board_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_tab_idx" ON "events" USING btree ("tab_id");--> statement-breakpoint
-- v2 backfill (idempotent). Existing single-user data → "boards with one admin member".
-- No content column is read-modified; this only copies view-state into board_members
-- and stamps attribution. Safe to re-run.
INSERT INTO "board_members" ("tab_id", "user_id", "role", "category_id", "position", "starred", "starred_position")
SELECT "id", "user_id", 'admin', "project_id", "position", "starred", "starred_position" FROM "tabs"
ON CONFLICT ("tab_id", "user_id") DO NOTHING;--> statement-breakpoint
UPDATE "tabs" SET "created_by" = "user_id" WHERE "created_by" IS NULL;--> statement-breakpoint
UPDATE "tasks" SET "created_by" = "user_id" WHERE "created_by" IS NULL;--> statement-breakpoint
-- Seed the first platform admin. Edit the email if your founder account differs;
-- a no-match simply updates 0 rows (harmless) and you can promote later.
UPDATE "users" SET "role" = 'admin' WHERE "email" = 'kirill.k.knyazev@gmail.com';