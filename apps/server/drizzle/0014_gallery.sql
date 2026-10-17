-- 图库（手写了两处，其余是 drizzle-kit 生成的）：
-- 1. 开头建 pgvector 扩展：数据库镜像从 2026-10-17 起换成 docker.io/pgvector/pgvector:0.8.7-pg18-trixie（Postgres 18.6 + pgvector，数据卷和原来的 postgres:18 通用）；
-- 2. 结尾给 gallery_images、api_keys 加实时推送触发器（写法同 0001_triggers.sql）。gallery_embeddings 不推：行里有 1024 维的向量，NOTIFY 的 to_jsonb 太大。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TYPE "public"."model_role" ADD VALUE 'embed';--> statement-breakpoint
CREATE SEQUENCE "public"."api_key_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."gallery_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hint" text NOT NULL,
	"sha256" text NOT NULL,
	"created_by_id" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "gallery_embeddings" (
	"image_id" text NOT NULL,
	"model_id" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gallery_embeddings_image_id_model_id_pk" PRIMARY KEY("image_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "gallery_images" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"thumb_file_id" text NOT NULL,
	"sha256" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"text" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"via" text NOT NULL,
	"created_by_id" text,
	"api_key_id" text,
	"session_id" text,
	"embed_error" text,
	"embed_tried_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_embeddings" ADD CONSTRAINT "gallery_embeddings_image_id_gallery_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."gallery_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_thumb_file_id_files_id_fk" FOREIGN KEY ("thumb_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gallery_embeddings_hnsw_idx" ON "gallery_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "gallery_images_sha256_idx" ON "gallery_images" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "gallery_images_created_idx" ON "gallery_images" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gallery_images_tags_idx" ON "gallery_images" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "gallery_images_text_idx" ON "gallery_images" USING gin ("text" jsonb_path_ops);--> statement-breakpoint
CREATE TRIGGER gallery_images_notify_change AFTER INSERT OR UPDATE OR DELETE ON "gallery_images" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');--> statement-breakpoint
CREATE TRIGGER api_keys_notify_change AFTER INSERT OR UPDATE OR DELETE ON "api_keys" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
