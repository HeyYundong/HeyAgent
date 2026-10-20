-- Session 空间（docs/dev/session-space.md）：agent 写的文件按路径存、同一路径覆盖（id 不变），记最后一次覆盖的时间
ALTER TABLE "files" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- 已有的文件没覆盖过：更新时间 = 创建时间
UPDATE "files" SET "updated_at" = "created_at";--> statement-breakpoint
CREATE UNIQUE INDEX "files_session_path_idx" ON "files" USING btree ("session_id","path") WHERE "files"."kind" = 'artifact' and "files"."path" is not null;
