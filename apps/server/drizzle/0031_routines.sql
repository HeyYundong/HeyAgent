CREATE TYPE "public"."routine_mode" AS ENUM('off', 'first');--> statement-breakpoint
CREATE TYPE "public"."routine_status" AS ENUM('trial', 'active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."routine_version_status" AS ENUM('drafting', 'testing', 'review', 'failed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('run', 'routine_test');--> statement-breakpoint
ALTER TYPE "public"."human_item_kind" ADD VALUE 'routine';--> statement-breakpoint
ALTER TYPE "public"."model_role" ADD VALUE 'solidify';--> statement-breakpoint
CREATE SEQUENCE "public"."routine_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "routine_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" "routine_version_status" DEFAULT 'drafting' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commits" text[] DEFAULT '{}'::text[] NOT NULL,
	"assumptions" text[] DEFAULT '{}'::text[] NOT NULL,
	"fail_reason" text,
	"source_session_id" text,
	"base_version" integer,
	"round" integer DEFAULT 0 NOT NULL,
	"skip_test" boolean DEFAULT false NOT NULL,
	"test_report" jsonb,
	"model_id" text,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"reject_reason" text,
	"created_by_id" text,
	"approved_by_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"status" "routine_status" DEFAULT 'trial' NOT NULL,
	"active_version" integer,
	"direct_streak" integer DEFAULT 0 NOT NULL,
	"fallback_streak" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "human_items" ADD COLUMN "routine_version_id" text;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "trace" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" "session_kind" DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "routine" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "routine_mode" "routine_mode" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_versions" ADD CONSTRAINT "routine_versions_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_versions_routine_version_idx" ON "routine_versions" USING btree ("routine_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "routines_task_id_idx" ON "routines" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "human_items" ADD CONSTRAINT "human_items_routine_version_id_routine_versions_id_fk" FOREIGN KEY ("routine_version_id") REFERENCES "public"."routine_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- 实时推送（手写，drizzle-kit 不生成触发器）：任务详情的「固化流程」、审核卡
CREATE TRIGGER routines_notify_change AFTER INSERT OR UPDATE OR DELETE ON "routines" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');--> statement-breakpoint
CREATE TRIGGER routine_versions_notify_change AFTER INSERT OR UPDATE OR DELETE ON "routine_versions" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('routine_id');
