CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"task_id" text,
	"session_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "session_waits" ADD COLUMN "human_item_id" text;--> statement-breakpoint
ALTER TABLE "session_waits" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "created_by_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "step_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cost_limit_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "max_steps" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "event_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "msg_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_waits" ADD CONSTRAINT "session_waits_human_item_id_human_items_id_fk" FOREIGN KEY ("human_item_id") REFERENCES "public"."human_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_task_id_idx" ON "files" USING btree ("task_id");--> statement-breakpoint
-- 手写：实时推送（同 0001）。通知按收件人推，文件按所属 session 推（任务附件的 session_id 为空）
CREATE TRIGGER notifications_notify_change AFTER INSERT OR UPDATE OR DELETE ON "notifications" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('user_id');
--> statement-breakpoint
CREATE TRIGGER files_notify_change AFTER INSERT OR UPDATE OR DELETE ON "files" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('session_id');