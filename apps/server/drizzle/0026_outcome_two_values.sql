-- 结果只留办成 / 没办成（docs/dev/run-outcome.md 开头「2026-10-20 简化」）：复核一定做，任务里的复核开关去掉
ALTER TABLE "tasks" DROP COLUMN "review_enabled";--> statement-breakpoint
-- 复核模型必填：没选的旧任务补上默认复核模型；没有默认复核模型的留空（下次保存时要选，开始运行时会拦下）
UPDATE "tasks" SET "review_model_id" = (SELECT "model_id" FROM "model_defaults" WHERE "role" = 'review')
WHERE "review_model_id" IS NULL;--> statement-breakpoint
-- 部分办成、没核实都算没办成：原因前面写上原来记的是什么，原来的原因接在后面。枚举值 partial / unverified 留着不用（删不掉）
UPDATE "sessions" SET
  "outcome" = 'not_achieved',
  "outcome_reason" = CASE "outcome" WHEN 'partial' THEN '原来记「部分办成」：' ELSE '原来记「没核实」：' END || coalesce("outcome_reason", '')
WHERE "outcome" IN ('partial', 'unverified');--> statement-breakpoint
-- 派活单同样改结果；单的状态不改（原来「没核实」的单还是办完）
UPDATE "work_items" SET
  "outcome" = 'not_achieved',
  "outcome_reason" = CASE "outcome" WHEN 'partial' THEN '原来记「部分办成」：' ELSE '原来记「没核实」：' END || coalesce("outcome_reason", '')
WHERE "outcome" IN ('partial', 'unverified');
