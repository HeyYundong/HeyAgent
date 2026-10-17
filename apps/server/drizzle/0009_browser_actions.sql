CREATE TABLE "browser_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "browser_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"profile_id" text NOT NULL,
	"session_id" text,
	"url" text NOT NULL,
	"action" text NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_actions" ADD CONSTRAINT "browser_actions_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_actions" ADD CONSTRAINT "browser_actions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_actions_profile_at_idx" ON "browser_actions" USING btree ("profile_id","at");--> statement-breakpoint
-- 手写：新记的操作推给浏览器页（写法同 0001_triggers.sql，id 用 profile_id）。只推 INSERT：清理 90 天前的旧记录不用推。
CREATE TRIGGER browser_actions_notify_change AFTER INSERT ON "browser_actions" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('profile_id');
