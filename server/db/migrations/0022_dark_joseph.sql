ALTER TABLE "events" ALTER COLUMN "tab_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "filter" jsonb;