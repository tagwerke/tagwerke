ALTER TABLE "audit_log" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tabs" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reviewer_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_scope_idx" ON "audit_log" USING btree ("scope_id","created_at");