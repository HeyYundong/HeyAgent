-- 自定义迁移：触发器（drizzle-kit 不生成触发器，这个文件是手写的）。

-- 1. 实时推送：业务表有增删改就 NOTIFY heyagent_changes，内容是 {"table": 表名, "id": 行 id}。
--    API 进程 LISTEN 这个频道，再通过 tRPC 订阅（SSE）推给前端，前端按表让查询失效。
--    第一个参数是用哪一列当 id（关联表用它所属对象的 id，例如 session_events 用 session_id）。
--    批量灌数据时可以 SET LOCAL heyagent.skip_notify = 'on' 暂时不发，灌完自己发一条 {"table": "*"}。
CREATE OR REPLACE FUNCTION heyagent_notify_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
BEGIN
  IF current_setting('heyagent.skip_notify', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;
  PERFORM pg_notify('heyagent_changes', json_build_object('table', TG_TABLE_NAME, 'id', row_data ->> TG_ARGV[0])::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_notify_change AFTER INSERT OR UPDATE OR DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER platforms_notify_change AFTER INSERT OR UPDATE OR DELETE ON "platforms" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER tasks_notify_change AFTER INSERT OR UPDATE OR DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER task_memories_notify_change AFTER INSERT OR UPDATE OR DELETE ON "task_memories" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('task_id');
--> statement-breakpoint
CREATE TRIGGER task_skills_notify_change AFTER INSERT OR UPDATE OR DELETE ON "task_skills" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('task_id');
--> statement-breakpoint
CREATE TRIGGER task_tools_notify_change AFTER INSERT OR UPDATE OR DELETE ON "task_tools" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('task_id');
--> statement-breakpoint
CREATE TRIGGER task_rules_notify_change AFTER INSERT OR UPDATE OR DELETE ON "task_rules" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('task_id');
--> statement-breakpoint
CREATE TRIGGER sessions_notify_change AFTER INSERT OR UPDATE OR DELETE ON "sessions" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER session_events_notify_change AFTER INSERT OR UPDATE OR DELETE ON "session_events" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('session_id');
--> statement-breakpoint
CREATE TRIGGER checkpoints_notify_change AFTER INSERT OR UPDATE OR DELETE ON "checkpoints" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('session_id');
--> statement-breakpoint
CREATE TRIGGER checkpoint_records_notify_change AFTER INSERT OR UPDATE OR DELETE ON "checkpoint_records" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('checkpoint_id');
--> statement-breakpoint
CREATE TRIGGER session_waits_notify_change AFTER INSERT OR UPDATE OR DELETE ON "session_waits" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('session_id');
--> statement-breakpoint
CREATE TRIGGER human_items_notify_change AFTER INSERT OR UPDATE OR DELETE ON "human_items" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER human_todos_notify_change AFTER INSERT OR UPDATE OR DELETE ON "human_todos" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER memories_notify_change AFTER INSERT OR UPDATE OR DELETE ON "memories" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER skills_notify_change AFTER INSERT OR UPDATE OR DELETE ON "skills" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER skill_tools_notify_change AFTER INSERT OR UPDATE OR DELETE ON "skill_tools" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('skill_id');
--> statement-breakpoint
CREATE TRIGGER skill_suggestions_notify_change AFTER INSERT OR UPDATE OR DELETE ON "skill_suggestions" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('skill_id');
--> statement-breakpoint
CREATE TRIGGER rules_notify_change AFTER INSERT OR UPDATE OR DELETE ON "rules" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER rule_tools_notify_change AFTER INSERT OR UPDATE OR DELETE ON "rule_tools" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('rule_id');
--> statement-breakpoint
CREATE TRIGGER tools_notify_change AFTER INSERT OR UPDATE OR DELETE ON "tools" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER mcp_servers_notify_change AFTER INSERT OR UPDATE OR DELETE ON "mcp_servers" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER secrets_notify_change AFTER INSERT OR UPDATE OR DELETE ON "secrets" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER browser_profiles_notify_change AFTER INSERT OR UPDATE OR DELETE ON "browser_profiles" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER browser_accounts_notify_change AFTER INSERT OR UPDATE OR DELETE ON "browser_accounts" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('profile_id');
--> statement-breakpoint
CREATE TRIGGER browser_vaults_notify_change AFTER INSERT OR UPDATE OR DELETE ON "browser_vaults" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('profile_id');
--> statement-breakpoint
CREATE TRIGGER account_leases_notify_change AFTER INSERT OR UPDATE OR DELETE ON "account_leases" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('account_id');
--> statement-breakpoint
CREATE TRIGGER model_providers_notify_change AFTER INSERT OR UPDATE OR DELETE ON "model_providers" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('id');
--> statement-breakpoint
CREATE TRIGGER models_notify_change AFTER INSERT OR UPDATE OR DELETE ON "models" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('provider_id');
--> statement-breakpoint
CREATE TRIGGER model_defaults_notify_change AFTER INSERT OR UPDATE OR DELETE ON "model_defaults" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('role');
--> statement-breakpoint
-- 2. 只追加：session_events 不许改；session_messages 只许改 compacted（压缩上下文时打标记），内容不许改。
CREATE OR REPLACE FUNCTION heyagent_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 只能追加，不能修改已有的行', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_events_append_only BEFORE UPDATE ON "session_events" FOR EACH ROW EXECUTE FUNCTION heyagent_append_only();
--> statement-breakpoint
CREATE TRIGGER session_messages_append_only BEFORE UPDATE OF "session_id", "seq", "role", "content", "created_at" ON "session_messages" FOR EACH ROW EXECUTE FUNCTION heyagent_append_only();
