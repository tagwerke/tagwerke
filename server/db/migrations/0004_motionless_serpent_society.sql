CREATE TABLE "inbound_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"suggested_date" text,
	"suggested_owner" text,
	"confidence" smallint,
	"from_addr" text,
	"subject" text,
	"snippet" text,
	"message_id" text,
	"extraction_failed" boolean DEFAULT false NOT NULL,
	"kept_task_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_drafts" ADD CONSTRAINT "inbound_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_drafts_user_idx" ON "inbound_drafts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inbound_drafts_status_idx" ON "inbound_drafts" USING btree ("user_id","status");