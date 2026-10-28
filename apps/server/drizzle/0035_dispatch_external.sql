ALTER TYPE "public"."work_via" ADD VALUE 'api';--> statement-breakpoint
ALTER TYPE "public"."work_via" ADD VALUE 'event';--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "from_event" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_items_task_queue_idx" ON "work_items" USING btree ("task_id","status","priority" DESC NULLS LAST,"created_at","id");--> statement-breakpoint
CREATE INDEX "work_items_api_key_idx" ON "work_items" USING btree ("api_key_id");