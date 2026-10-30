-- 任务的交付物（docs/dev/task-structure.md）：每次运行要交出来的东西 [{ name, description }]。drizzle-kit 生成，加了 IF NOT EXISTS 和这段说明；
-- 以前建的任务默认空数组（没写交付物）。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL;
