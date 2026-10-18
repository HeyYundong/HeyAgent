CREATE TYPE "public"."work_item_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_via" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE SEQUENCE "public"."work_item_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "task_dispatch_sources" (
	"task_id" text NOT NULL,
	"source_task_id" text NOT NULL,
	CONSTRAINT "task_dispatch_sources_task_id_source_task_id_pk" PRIMARY KEY("task_id","source_task_id")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" "work_item_status" NOT NULL,
	"session_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"via" "work_via" NOT NULL,
	"from_task_id" text,
	"from_session_id" text,
	"from_user_id" text,
	"depth" integer DEFAULT 1 NOT NULL,
	"result" jsonb,
	"error" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "work_item_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "dispatch" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cron_skip_if_running" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dispatch_sources" ADD CONSTRAINT "task_dispatch_sources_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_sources" ADD CONSTRAINT "task_dispatch_sources_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_from_task_id_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_from_session_id_sessions_id_fk" FOREIGN KEY ("from_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dispatch_sources_source_idx" ON "task_dispatch_sources" USING btree ("source_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_task_key_idx" ON "work_items" USING btree ("task_id","key");--> statement-breakpoint
CREATE INDEX "work_items_task_status_idx" ON "work_items" USING btree ("task_id","status","created_at");--> statement-breakpoint
CREATE INDEX "work_items_created_idx" ON "work_items" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "work_items_from_session_idx" ON "work_items" USING btree ("from_session_id");--> statement-breakpoint
CREATE INDEX "work_items_from_task_idx" ON "work_items" USING btree ("from_task_id");--> statement-breakpoint
CREATE INDEX "work_items_session_idx" ON "work_items" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_work_item_id_idx" ON "sessions" USING btree ("work_item_id");--> statement-breakpoint
-- 手写：派活单有增删改就推给前端（写法同 0001_triggers.sql）
CREATE TRIGGER work_items_notify_change AFTER INSERT OR UPDATE OR DELETE ON "work_items" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
