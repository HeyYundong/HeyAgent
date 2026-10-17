ALTER TABLE "checkpoints" ADD COLUMN "focused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "compiled_text" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "compile_draft" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "confirmed_by_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "session_waits" ADD COLUMN "pending" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rule_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "verify_model_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;