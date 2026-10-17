CREATE TABLE "task_memory_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_memory_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" text NOT NULL,
	"content" text NOT NULL,
	"source_session_id" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "digest" jsonb;--> statement-breakpoint
ALTER TABLE "task_memory_entries" ADD CONSTRAINT "task_memory_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_memory_entries" ADD CONSTRAINT "task_memory_entries_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_memory_entries" ADD CONSTRAINT "task_memory_entries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_memory_entries_task_id_idx" ON "task_memory_entries" USING btree ("task_id","id");--> statement-breakpoint
-- 手写：任务记忆有增删改就推给前端（写法同 0001_triggers.sql，id 用 task_id）
CREATE TRIGGER task_memory_entries_notify_change AFTER INSERT OR UPDATE OR DELETE ON "task_memory_entries" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('task_id');
