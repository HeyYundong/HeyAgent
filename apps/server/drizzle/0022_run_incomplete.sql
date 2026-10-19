-- 运行的新状态「没完成」：正常结束但事情没做成（agent 报了没完成、被派的运行报了办不成、检查点没达成），原因写在 sessions.error
ALTER TYPE "public"."run_status" ADD VALUE 'incomplete' BEFORE 'failed';
