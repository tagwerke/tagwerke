-- BOARD_STATES_PLAN P1 — per-board task states.
--
-- Hand-edited after `drizzle-kit generate`: the INSERT at the end seeds every existing board with
-- the six default states (shared/status.ts DEFAULT_STATES — keep the two in step). The seeded keys
-- are the keys tasks already store (status was enum-validated), so no task row is rewritten.
-- Data, not schema, so the drizzle snapshot doesn't model it and the next generate won't drift.
--
-- `tasks.done` is dropped: nothing read it, it was only ever written to mirror the status.

CREATE TABLE "board_states" (
	"id" text PRIMARY KEY NOT NULL,
	"tab_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_states" ADD CONSTRAINT "board_states_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_states_tab_key_uniq" ON "board_states" USING btree ("tab_id","key");--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "done";
--> statement-breakpoint
INSERT INTO "board_states" ("id","tab_id","key","label","description","category","color","position")
SELECT gen_random_uuid()::text, t."id", d.key, d.label, d.description, d.category, d.color, d.position
FROM "tabs" t CROSS JOIN (VALUES
  ('todo','Todo','Not started yet.','open','grey',0),
  ('in_progress','In progress','Someone is working on it.','active','blue',1),
  ('blocked','Blocked','Stuck on someone or something. Say what in a comment.','waiting','red',2),
  ('in_review','In review','Work is done and waiting for someone to look at it.','waiting','purple',3),
  ('done','Done','Finished.','done','green',4),
  ('cancelled','Cancelled','Dropped. It won''t be done.','closed','slate',5)
) AS d(key,label,description,category,color,position);
