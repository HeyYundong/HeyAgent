ALTER TYPE "public"."session_kind" ADD VALUE 'sub';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sub_result" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subagent_model_id" text;