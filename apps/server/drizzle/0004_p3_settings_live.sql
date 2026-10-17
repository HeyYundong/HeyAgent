-- 手写（M1 P3）：settings 表也做实时推送，写法同 0001_triggers.sql。id 用设置的键名（例如 session.maxCostUsd）。
-- 设置页改了花费上限、通知渠道等，别的管理员打开的设置页会自动刷新。
CREATE TRIGGER settings_notify_change AFTER INSERT OR UPDATE OR DELETE ON "settings" FOR EACH ROW EXECUTE FUNCTION heyagent_notify_change('key');
