ALTER TABLE "work_items" ADD COLUMN "fail_kind" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "auto_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "work_items_task_not_before_idx" ON "work_items" USING btree ("task_id","status","not_before");