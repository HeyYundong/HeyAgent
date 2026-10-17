CREATE TABLE "browser_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"kind" text NOT NULL,
	"profile_id" text NOT NULL,
	"session_id" text,
	"account_id" text,
	"opened_by_id" text,
	"state" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"viewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hold_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"control_url" text NOT NULL,
	"max_browsers" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "browser_profile_id" text;--> statement-breakpoint
ALTER TABLE "browser_instances" ADD CONSTRAINT "browser_instances_worker_id_browser_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."browser_workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_instances" ADD CONSTRAINT "browser_instances_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_instances" ADD CONSTRAINT "browser_instances_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_instances" ADD CONSTRAINT "browser_instances_account_id_browser_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."browser_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_instances" ADD CONSTRAINT "browser_instances_opened_by_id_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_instances_session_id_idx" ON "browser_instances" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "browser_instances_worker_id_idx" ON "browser_instances" USING btree ("worker_id");--> statement-breakpoint
-- 手写（M2）：开着的 Chrome 也做实时推送（浏览器页「谁在看」、session 的「看浏览器」入口），写法同 0001_triggers.sql。
-- browser_workers 只有心跳，不推送。
CREATE TRIGGER browser_instances_notify_change AFTER INSERT OR UPDATE OR DELETE ON "browser_instances" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
