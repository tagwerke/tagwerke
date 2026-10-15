CREATE TABLE "secret_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tab_id" text NOT NULL,
	"name" text NOT NULL,
	"username_enc" text,
	"secret_enc" text NOT NULL,
	"url_enc" text,
	"notes_enc" text,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_links" (
	"id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"created_by" text,
	"tab_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"viewed_at" timestamp with time zone,
	"viewed_ip" "inet",
	"pin_prefix" integer DEFAULT 32 NOT NULL,
	"foreign_attempt_at" timestamp with time zone,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "secret_policies" (
	"tab_id" text PRIMARY KEY NOT NULL,
	"allowed_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_entries" ADD CONSTRAINT "secret_entries_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_entries" ADD CONSTRAINT "secret_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_entries" ADD CONSTRAINT "secret_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_links" ADD CONSTRAINT "secret_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_links" ADD CONSTRAINT "secret_links_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_policies" ADD CONSTRAINT "secret_policies_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_policies" ADD CONSTRAINT "secret_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_entries_tab_idx" ON "secret_entries" USING btree ("tab_id");--> statement-breakpoint
CREATE INDEX "secret_links_expiry_idx" ON "secret_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "secret_links_creator_idx" ON "secret_links" USING btree ("created_by","created_at");