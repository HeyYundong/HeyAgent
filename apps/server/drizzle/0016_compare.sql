CREATE TYPE "public"."compare_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."compare_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."compare_via" AS ENUM('web', 'agent', 'api', 'mcp');--> statement-breakpoint
CREATE SEQUENCE "public"."compare_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."compare_standard_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "compare_standards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"pass_score" integer NOT NULL,
	"model_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" "compare_status" NOT NULL,
	"file_a_id" text NOT NULL,
	"file_b_id" text NOT NULL,
	"label_a" text DEFAULT '' NOT NULL,
	"label_b" text DEFAULT '' NOT NULL,
	"from_a" text DEFAULT '' NOT NULL,
	"from_b" text DEFAULT '' NOT NULL,
	"standard_id" text,
	"standard_name" text,
	"prompt" text NOT NULL,
	"pass_score" integer NOT NULL,
	"model_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"score" integer,
	"confidence" "compare_confidence",
	"verdict" text DEFAULT '' NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dimensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" text,
	"error" text,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"via" "compare_via" NOT NULL,
	"created_by_id" text,
	"session_id" text,
	"task_id" text,
	"api_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compare_standards" ADD CONSTRAINT "compare_standards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_file_a_id_files_id_fk" FOREIGN KEY ("file_a_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_file_b_id_files_id_fk" FOREIGN KEY ("file_b_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_standard_id_compare_standards_id_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."compare_standards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compare_standards_name_idx" ON "compare_standards" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "compare_standards_default_idx" ON "compare_standards" USING btree ("is_default") WHERE "compare_standards"."is_default";--> statement-breakpoint
CREATE INDEX "comparisons_created_idx" ON "comparisons" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comparisons_dedupe_idx" ON "comparisons" USING btree ("dedupe_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comparisons_session_idx" ON "comparisons" USING btree ("session_id");--> statement-breakpoint
-- 手写：比对记录、比对标准有增删改就推给前端（写法同 0001_triggers.sql）
CREATE TRIGGER comparisons_notify_change AFTER INSERT OR UPDATE OR DELETE ON "comparisons" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');--> statement-breakpoint
CREATE TRIGGER compare_standards_notify_change AFTER INSERT OR UPDATE OR DELETE ON "compare_standards" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
