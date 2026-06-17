CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tabs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"starred_position" integer,
	"type" text DEFAULT 'normal' NOT NULL,
	"date_key" text,
	"doc_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"home_tab_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"date" text,
	"priority" smallint,
	"owner" text,
	"done" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "today_block_tasks" (
	"block_id" text NOT NULL,
	"task_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "today_block_tasks_block_id_task_id_pk" PRIMARY KEY("block_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "today_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tab_id" text NOT NULL,
	"home_tab_id" text,
	"start" text,
	"end" text,
	"label" text,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tabs" ADD CONSTRAINT "tabs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_home_tab_id_tabs_id_fk" FOREIGN KEY ("home_tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_block_tasks" ADD CONSTRAINT "today_block_tasks_block_id_today_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."today_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_block_tasks" ADD CONSTRAINT "today_block_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_blocks" ADD CONSTRAINT "today_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "today_blocks" ADD CONSTRAINT "today_blocks_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "snapshots_user_idx" ON "snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tabs_user_idx" ON "tabs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tabs_project_idx" ON "tabs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_home_tab_idx" ON "tasks" USING btree ("home_tab_id");--> statement-breakpoint
CREATE INDEX "today_blocks_user_idx" ON "today_blocks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "today_blocks_tab_idx" ON "today_blocks" USING btree ("tab_id");