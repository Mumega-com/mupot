-- Roll application code back before removing its additive metadata column.
-- No original task data or notice text is removed.
DROP TRIGGER IF EXISTS tasks_gate_wake_notice_review_reset;
ALTER TABLE tasks DROP COLUMN gate_wake_notice_at;
