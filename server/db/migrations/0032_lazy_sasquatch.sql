CREATE TABLE "document_items" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"tab_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source_quote" text NOT NULL,
	"source_offset" integer,
	"due_date" text,
	"confidence" real,
	"status" text DEFAULT 'proposed' NOT NULL,
	"edited_at" timestamp with time zone,
	"edited_by" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "text_content" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "text_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "text_chars" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_tab_id_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_items_doc_idx" ON "document_items" USING btree ("document_id","kind");--> statement-breakpoint
CREATE INDEX "document_items_tab_idx" ON "document_items" USING btree ("tab_id");