CREATE TYPE "public"."import_status" AS ENUM('reading', 'review', 'imported', 'failed', 'undone');--> statement-breakpoint
ALTER TYPE "public"."secret_scope" ADD VALUE 'import';--> statement-breakpoint
CREATE SEQUENCE "public"."import_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "imports" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"name" text,
	"note" text DEFAULT '' NOT NULL,
	"model_id" text NOT NULL,
	"status" "import_status" NOT NULL,
	"read_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan" jsonb,
	"step" text DEFAULT 'overview' NOT NULL,
	"visited" text[] DEFAULT '{}'::text[] NOT NULL,
	"result" jsonb,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text,
	"created_by_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"imported_at" timestamp with time zone,
	"imported_by_id" text,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_imported_by_id_users_id_fk" FOREIGN KEY ("imported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imports_created_at_idx" ON "imports" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
-- 手写：导入记录有增删改就推给前端（写法同 0001_triggers.sql）。读包时每读一个文件更新一次 read_log，页面跟着刷新
CREATE TRIGGER imports_notify_change AFTER INSERT OR UPDATE OR DELETE ON "imports" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
