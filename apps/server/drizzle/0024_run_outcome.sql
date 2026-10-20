CREATE TYPE "public"."run_outcome_by" AS ENUM('agent', 'rule', 'review', 'verify', 'human');--> statement-breakpoint
CREATE TYPE "public"."run_outcome" AS ENUM('achieved', 'partial', 'not_achieved', 'unverified');--> statement-breakpoint
ALTER TYPE "public"."model_role" ADD VALUE 'review';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "outcome" "run_outcome";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "outcome_by" "run_outcome_by";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "review_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "review_model_id" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "outcome" "run_outcome";--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "outcome_reason" text;--> statement-breakpoint
-- 补旧数据（docs/dev/run-outcome.md 第 7 节）：只按规则推算，不花钱；「没核实」的旧运行另用 outcome:review 命令复核
-- 1. 没完成（incomplete）→ 已结束 + 没办成；agent 自己报的（事件标题「agent 报…」）记 agent，其余记 rule。
--    按文本比较：0022 刚加的枚举值和这里在同一个事务里时不能当字面量用
UPDATE "sessions" s SET
  "status" = 'done',
  "outcome" = 'not_achieved',
  "outcome_reason" = s."error",
  "outcome_by" = CASE WHEN EXISTS (
    SELECT 1 FROM "session_events" e WHERE e."session_id" = s."id" AND e."kind" = 'done' AND e."title" LIKE 'agent 报%'
  ) THEN 'agent'::"run_outcome_by" ELSE 'rule'::"run_outcome_by" END
WHERE s."status"::text = 'incomplete';--> statement-breakpoint
-- 2. 出错（含取消）→ 没办成，原因 = 错误信息
UPDATE "sessions" SET "outcome" = 'not_achieved', "outcome_reason" = "error", "outcome_by" = 'rule'
WHERE "status" = 'failed' AND "outcome" IS NULL;--> statement-breakpoint
-- 3. 已结束：检查点有没达成的、或者全部跳过 → 没办成
UPDATE "sessions" s SET
  "outcome" = 'not_achieved',
  "outcome_by" = 'rule',
  "outcome_reason" = CASE
    WHEN EXISTS (SELECT 1 FROM "checkpoints" c WHERE c."session_id" = s."id" AND c."status" = 'open')
      THEN (SELECT count(*) || ' 个检查点没达成：' || string_agg(c."title", '、' ORDER BY c."position") FROM "checkpoints" c WHERE c."session_id" = s."id" AND c."status" = 'open')
    ELSE (SELECT count(*) || ' 个检查点全部跳过，一个都没达成：' || string_agg(c."title", '、' ORDER BY c."position") FROM "checkpoints" c WHERE c."session_id" = s."id")
  END
WHERE s."status" = 'done' AND s."outcome" IS NULL
  AND (s."verification" IS NULL OR s."verification"->>'status' <> 'passed')
  AND EXISTS (SELECT 1 FROM "checkpoints" c WHERE c."session_id" = s."id")
  AND (
    EXISTS (SELECT 1 FROM "checkpoints" c WHERE c."session_id" = s."id" AND c."status" = 'open')
    OR NOT EXISTS (SELECT 1 FROM "checkpoints" c WHERE c."session_id" = s."id" AND c."status" <> 'skipped')
  );--> statement-breakpoint
-- 4. 已结束：三方验收通过 → 办成
UPDATE "sessions" SET "outcome" = 'achieved', "outcome_by" = 'verify', "outcome_reason" = "verification"->>'headline'
WHERE "status" = 'done' AND "outcome" IS NULL AND "verification"->>'status' = 'passed';--> statement-breakpoint
-- 5. 已结束：检查点部分跳过（其余都达成）→ 部分办成
UPDATE "sessions" s SET
  "outcome" = 'partial',
  "outcome_by" = 'rule',
  "outcome_reason" = (SELECT count(*) || ' 个检查点跳过：' || string_agg(c."title", '、' ORDER BY c."position") FROM "checkpoints" c WHERE c."session_id" = s."id" AND c."status" = 'skipped')
WHERE s."status" = 'done' AND s."outcome" IS NULL
  AND EXISTS (SELECT 1 FROM "checkpoints" c WHERE c."session_id" = s."id" AND c."status" = 'skipped');--> statement-breakpoint
-- 6. 已结束：其余 → 没核实（检查点全部达成也一样：旧运行的检查点是 agent 自己勾的，等复核）
UPDATE "sessions" SET "outcome" = 'unverified', "outcome_by" = 'rule', "outcome_reason" = '旧运行，agent 说做完了，还没核实'
WHERE "status" = 'done' AND "outcome" IS NULL;--> statement-breakpoint
-- 7. 派活单：结束了的单按它最后那次运行补结果；不办了的记没办成。单的状态不改
UPDATE "work_items" w SET "outcome" = s."outcome", "outcome_reason" = s."outcome_reason"
FROM "sessions" s
WHERE w."session_id" = s."id" AND w."status" IN ('done', 'failed') AND s."outcome" IS NOT NULL;--> statement-breakpoint
UPDATE "work_items" SET "outcome" = 'not_achieved', "outcome_reason" = coalesce("error", '不办了')
WHERE "outcome" IS NULL AND "status" IN ('failed', 'cancelled');
