CREATE TABLE "org" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
