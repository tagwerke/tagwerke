CREATE TABLE "sprints" (
	"id" text PRIMARY KEY NOT NULL,
	"tab_id" text NOT NULL,
	"label" text NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprints_tab_id_id_uniq" UNIQUE("tab_id","id"),
	CONSTRAINT "sprints_tab_starts_uniq" UNIQUE("tab_id","starts_at")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sprint_id" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sprints_one_current_per_tab" ON "sprints" USING btree ("tab_id") WHERE "sprints"."is_current";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sprint_same_board" FOREIGN KEY ("home_tab_id","sprint_id") REFERENCES "public"."sprints"("tab_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_sprint_idx" ON "tasks" USING btree ("home_tab_id","sprint_id","rank");