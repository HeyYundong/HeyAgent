ALTER TYPE "public"."model_role" ADD VALUE 'assistant';--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD COLUMN "max_steps" integer;--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD COLUMN "max_cost_usd" numeric(12, 6);--> statement-breakpoint
-- 以前的 model_id 是自动记的「上次用的模型」；以后只存人在本对话设置里明确选的（docs/dev/copilot.md 10.1）
UPDATE "assistant_chats" SET "model_id" = NULL;
