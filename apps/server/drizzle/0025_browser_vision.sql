-- 在线表格 / 文档（2026-10-19 在分支 worktree-online-sheets 上是 0022_browser_vision，8080 的库已经跑过它）：任务开关「允许看画面」。
-- 2026-10-20 合进 main 时改成 0025；已经有这一列的库（8080）跳过
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "allow_browser_vision" boolean DEFAULT false NOT NULL;
