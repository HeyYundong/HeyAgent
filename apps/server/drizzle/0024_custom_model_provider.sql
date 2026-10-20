-- 自定义模型服务（任何兼容 OpenAI 聊天接口的服务）；models.manual = 人手动加的模型，刷新模型列表时不删
ALTER TYPE "public"."provider_kind" ADD VALUE 'custom';--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "manual" boolean DEFAULT false NOT NULL;