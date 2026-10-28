-- 记忆按内容自动挑选（docs/dev/memory-retrieval.md）。全部是 drizzle-kit 生成的，只加了这段说明：
-- 1. memory_embeddings：记忆的向量，按模型分开存（写法同 0014 的 gallery_embeddings；vector 扩展 0014 已经建好），不建 HNSW、不加实时推送触发器；
-- 2. memories 加 embed_error / embed_tried_at（算失败的原因和时间）；
-- 3. tasks 加 auto_memory（库里默认 false：已有的任务不变）和 auto_memory_limit（默认 5）。
CREATE TABLE "memory_embeddings" (
	"memory_id" text NOT NULL,
	"model_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embeddings_memory_id_model_id_pk" PRIMARY KEY("memory_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embed_error" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embed_tried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "auto_memory_limit" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_embeddings_model_id_idx" ON "memory_embeddings" USING btree ("model_id");