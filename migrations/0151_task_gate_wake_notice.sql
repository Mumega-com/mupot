-- 0149_task_gate_wake_notice.sql — operator-visible review wake outcomes.
--
-- A review transition is committed before its best-effort gate wake runs. The
-- wake therefore needs a durable, task-visible outcome: null used to make
-- absent, stale, and ambiguous gate holders indistinguishable from a wake that
-- was never attempted. This is metadata about the wake, not task execution
-- evidence and not a verdict.

ALTER TABLE tasks ADD COLUMN gate_wake_notice TEXT;
