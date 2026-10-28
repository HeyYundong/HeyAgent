CREATE TYPE "public"."routine_call_result" AS ENUM('achieved', 'not_achieved', 'bad_input', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."routine_call_via" AS ENUM('tool', 'script');--> statement-breakpoint
CREATE TYPE "public"."routine_library_status" AS ENUM('listed', 'paused', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."tool_source" ADD VALUE 'routine';--> statement-breakpoint
CREATE TABLE "routine_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "routine_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"routine_id" text NOT NULL,
	"version" integer NOT NULL,
	"session_id" text NOT NULL,
	"task_id" text NOT NULL,
	"call_id" text NOT NULL,
	"via" "routine_call_via" NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"result" "routine_call_result" NOT NULL,
	"stop_kind" text,
	"stop_step" integer,
	"stop_reason" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_library" (
	"routine_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" "routine_library_status" DEFAULT 'listed' NOT NULL,
	"published_version" integer NOT NULL,
	"requires" jsonb NOT NULL,
	"risk" "risk" NOT NULL,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"published_by_id" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_library_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "routine_library_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "routine_library_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"routine_id" text NOT NULL,
	"version" integer NOT NULL,
	"published_by_id" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requires" jsonb NOT NULL,
	"risk" "risk" NOT NULL,
	"compat" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_versions" ADD COLUMN "proven_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "routine_id" text;--> statement-breakpoint
ALTER TABLE "routine_calls" ADD CONSTRAINT "routine_calls_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_calls" ADD CONSTRAINT "routine_calls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_calls" ADD CONSTRAINT "routine_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_library" ADD CONSTRAINT "routine_library_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_library" ADD CONSTRAINT "routine_library_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_library_versions" ADD CONSTRAINT "routine_library_versions_routine_id_routine_library_routine_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routine_library"("routine_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_library_versions" ADD CONSTRAINT "routine_library_versions_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_calls_routine_at_idx" ON "routine_calls" USING btree ("routine_id","at");--> statement-breakpoint
CREATE INDEX "routine_calls_session_idx" ON "routine_calls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "routine_calls_task_idx" ON "routine_calls" USING btree ("task_id","at");--> statement-breakpoint
CREATE INDEX "routine_library_versions_routine_idx" ON "routine_library_versions" USING btree ("routine_id","published_at");--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tools_routine_id_idx" ON "tools" USING btree ("routine_id");--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_routine_check" CHECK ("tools"."source"::text <> 'routine' or "tools"."routine_id" is not null);--> statement-breakpoint
-- 补 proven_at（手写）：审计里记过转正式（routine.promote，detail.version）的那一版取最近一次的时间；
-- 现在是正式的流程，启用的那一版还没补上的取流程的更新时间（这个功能上线前转正式的）
UPDATE "routine_versions" AS v SET "proven_at" = a."at"
FROM (
	SELECT "target_id", ("detail"->>'version')::int AS "version", max("at") AS "at"
	FROM "audit_events"
	WHERE "action" = 'routine.promote' AND "target_table" = 'routines' AND ("detail"->>'version') ~ '^[0-9]+$'
	GROUP BY 1, 2
) AS a
WHERE v."routine_id" = a."target_id" AND v."version" = a."version" AND v."proven_at" IS NULL;--> statement-breakpoint
UPDATE "routine_versions" AS v SET "proven_at" = r."updated_at"
FROM "routines" AS r
WHERE r."id" = v."routine_id" AND r."status" = 'active' AND r."active_version" = v."version" AND v."proven_at" IS NULL;--> statement-breakpoint
-- 实时推送（手写，drizzle-kit 不生成触发器）：流程页的列表、详情，任务详情「固化流程」区块里的「在流程库里」
CREATE TRIGGER routine_library_notify_change AFTER INSERT OR UPDATE OR DELETE ON "routine_library" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('routine_id');--> statement-breakpoint
CREATE TRIGGER routine_library_versions_notify_change AFTER INSERT OR UPDATE OR DELETE ON "routine_library_versions" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('routine_id');--> statement-breakpoint
CREATE TRIGGER routine_calls_notify_change AFTER INSERT OR UPDATE OR DELETE ON "routine_calls" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('routine_id');