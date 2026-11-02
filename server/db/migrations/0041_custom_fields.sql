-- CUSTOM_FIELDS_PLAN P2 — per-board custom fields, and each task's values for them.
-- Additive only: existing tasks get an empty `fields` object.

CREATE TABLE "board_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"tab_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"position" integer NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "board_fields" ADD CONSTRAINT "board_fields_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_fields_tab_key_uniq" ON "board_fields" USING btree ("tab_id","key");