-- 0129_loop_control_receipts.sql — durable audit for governor signals (#1166).
--
-- loop_controls (0021) is the LIVE signal the driver honors and then deletes
-- (clearLoopControl). That makes it a poor audit trail: a pause/kill that was
-- consumed is indistinguishable from a pause/kill that never happened.
--
-- This table is the receipt the consumed signal cannot be. Append-only. One row
-- per issued action (a loop may be paused, resumed via a later promote, then
-- killed — each write is a new receipt). No UNIQUE(loop_id): upserting the live
-- signal must not collapse the history.
--
-- Purely additive — CREATE TABLE / INDEX / trigger IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS loop_control_receipts (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  loop_id    TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('pause', 'kill', 'budget_override')),
  value      TEXT,
  reason     TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  issued_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loop_control_receipts_loop
  ON loop_control_receipts (tenant, loop_id, issued_at DESC);

CREATE TRIGGER IF NOT EXISTS loop_control_receipts_no_update
  BEFORE UPDATE ON loop_control_receipts
BEGIN
  SELECT RAISE(ABORT, 'loop_control_receipts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS loop_control_receipts_no_delete
  BEFORE DELETE ON loop_control_receipts
BEGIN
  SELECT RAISE(ABORT, 'loop_control_receipts is append-only');
END;
