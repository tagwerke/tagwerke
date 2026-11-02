-- CUSTOM_FIELDS_PLAN P4 — each board's table columns, in order (shared/fields.ts).
-- Additive only: every existing board gets the built-in columns it shows today.

ALTER TABLE "tabs" ADD COLUMN "table_columns" jsonb DEFAULT '["status","assignee","due","priority","sprint","parent"]'::jsonb NOT NULL;
