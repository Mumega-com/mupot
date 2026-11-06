-- Roll back application code that reads these columns before executing this SQL.
-- This removes connection attribution only; receipt rows and append-only triggers remain.
DROP INDEX IF EXISTS idx_inbox_attempt_runtime_custody;
ALTER TABLE task_dispatch_runtime_receipts DROP COLUMN consenting_member_id;
ALTER TABLE task_dispatch_runtime_receipts DROP COLUMN attachment_id;
ALTER TABLE task_dispatch_runtime_receipts DROP COLUMN seat_id;
