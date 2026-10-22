-- 桌面（docs/dev/desktop.md）：桌面配置、占用（一台桌面同一时间只给一个运行）、任务的「允许哪些桌面 / 允许看画面」、运行用的桌面。
ALTER TYPE "public"."secret_scope" ADD VALUE 'desktop';--> statement-breakpoint
CREATE TABLE "desktop_leases" (
	"desktop_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"state" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"hold_until" timestamp with time zone,
	CONSTRAINT "desktop_leases_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "desktop_leases_state_check" CHECK ("desktop_leases"."state" in ('running', 'held'))
);
--> statement-breakpoint
CREATE TABLE "desktops" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mcp_url" text NOT NULL,
	"agent_url" text NOT NULL,
	"key_secret_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "desktop_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "desktop_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "allow_desktop_vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_leases" ADD CONSTRAINT "desktop_leases_desktop_id_desktops_id_fk" FOREIGN KEY ("desktop_id") REFERENCES "public"."desktops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_leases" ADD CONSTRAINT "desktop_leases_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktops" ADD CONSTRAINT "desktops_key_secret_id_secrets_id_fk" FOREIGN KEY ("key_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER desktops_notify_change AFTER INSERT OR UPDATE OR DELETE ON "desktops" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');--> statement-breakpoint
CREATE TRIGGER desktop_leases_notify_change AFTER INSERT OR UPDATE OR DELETE ON "desktop_leases" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('desktop_id');
