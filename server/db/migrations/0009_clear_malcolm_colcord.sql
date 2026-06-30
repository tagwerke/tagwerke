CREATE TABLE "board_activity" (
	"tab_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_edited_at" timestamp with time zone,
	CONSTRAINT "board_activity_tab_id_user_id_pk" PRIMARY KEY("tab_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "board_activity" ADD CONSTRAINT "board_activity_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_activity" ADD CONSTRAINT "board_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_activity_tab_idx" ON "board_activity" USING btree ("tab_id");